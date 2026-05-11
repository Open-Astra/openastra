#!/usr/bin/env node

// ── Astra Doctor ─────────────────────────────────────────────────────
// Standalone CLI diagnostic runner. Initializes Postgres, runs all
// diagnostic checks, and prints colorized results to the terminal.
//
// Usage:
//   npm run doctor
//   npx astra doctor

import { loadStandaloneEnv } from "./env.js";
import { initPostgres, closePool } from "../config/postgres.js";
import { runMigrations } from "../db/migrate.js";
import type { DiagnosticCheck, DiagnosticResult } from "../diagnostics/index.js";

// ── ANSI Helpers ───────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CELESTIAL = "\x1b[38;5;39m";
const ICE = "\x1b[38;5;117m";

// ── Status Formatting ──────────────────────────────────────────────

function statusIcon(status: DiagnosticCheck["status"]): string {
  switch (status) {
    case "pass": return `${GREEN}PASS${RESET}`;
    case "warn": return `${YELLOW}WARN${RESET}`;
    case "fail": return `${RED}FAIL${RESET}`;
  }
}

function overallBanner(status: DiagnosticResult["overallStatus"]): string {
  switch (status) {
    case "healthy":   return `${GREEN}${BOLD}HEALTHY${RESET}`;
    case "degraded":  return `${YELLOW}${BOLD}DEGRADED${RESET}`;
    case "unhealthy": return `${RED}${BOLD}UNHEALTHY${RESET}`;
  }
}

function printResults(result: DiagnosticResult): void {
  console.log();
  console.log(`${CELESTIAL}${BOLD}  Astra Diagnostics${RESET}`);
  console.log(`${DIM}  ${"─".repeat(50)}${RESET}`);
  console.log();

  // Group checks by category
  const categories: Array<{ label: string; prefix: string }> = [
    { label: "Connectivity", prefix: "connectivity" },
    { label: "Configuration", prefix: "config" },
    { label: "Migrations", prefix: "migration" },
    { label: "Agents", prefix: "agent" },
    { label: "Providers", prefix: "provider" },
    { label: "Memory", prefix: "memory" },
  ];

  for (const cat of categories) {
    const checks = result.checks.filter((c) => c.name.startsWith(cat.prefix));
    if (checks.length === 0) continue;

    console.log(`  ${BOLD}${cat.label}${RESET}`);

    for (const check of checks) {
      const icon = statusIcon(check.status);
      const duration = `${DIM}${check.durationMs}ms${RESET}`;
      console.log(`    ${icon}  ${check.name}  ${duration}`);
      console.log(`         ${DIM}${check.message}${RESET}`);
    }

    console.log();
  }

  // Handle any uncategorized checks
  const categorized = new Set(
    categories.flatMap((cat) =>
      result.checks.filter((c) => c.name.startsWith(cat.prefix)).map((c) => c.name),
    ),
  );
  const uncategorized = result.checks.filter((c) => !categorized.has(c.name));
  if (uncategorized.length > 0) {
    console.log(`  ${BOLD}Other${RESET}`);
    for (const check of uncategorized) {
      const icon = statusIcon(check.status);
      const duration = `${DIM}${check.durationMs}ms${RESET}`;
      console.log(`    ${icon}  ${check.name}  ${duration}`);
      console.log(`         ${DIM}${check.message}${RESET}`);
    }
    console.log();
  }

  // Summary
  const pass = result.checks.filter((c) => c.status === "pass").length;
  const warn = result.checks.filter((c) => c.status === "warn").length;
  const fail = result.checks.filter((c) => c.status === "fail").length;

  console.log(`${DIM}  ${"─".repeat(50)}${RESET}`);
  console.log(
    `  ${BOLD}Overall:${RESET} ${overallBanner(result.overallStatus)}` +
    `  ${ICE}(${result.durationMs}ms)${RESET}`,
  );
  console.log(
    `  ${GREEN}${pass} passed${RESET}` +
    `${warn > 0 ? `  ${YELLOW}${warn} warning(s)${RESET}` : ""}` +
    `${fail > 0 ? `  ${RED}${fail} failed${RESET}` : ""}`,
  );
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CELESTIAL}  Astra Doctor${RESET}`);
  console.log(`${DIM}  Initializing...${RESET}\n`);

  // Load environment (lightweight — does not require full gateway env)
  let env;
  try {
    env = loadStandaloneEnv();
  } catch (err) {
    // If no provider key is set, that's fine for diagnostics — we still
    // want to check Postgres and other infra. Fake minimal env.
    console.log(`${DIM}  [init] No inference provider detected — running infra checks only${RESET}`);
    env = null;
  }

  // Initialize PostgreSQL
  initPostgres({
    host: env?.pgHost ?? process.env.PG_HOST ?? "localhost",
    port: env?.pgPort ?? parseInt(process.env.PG_PORT ?? "5432", 10),
    database: env?.pgDatabase ?? process.env.PG_DATABASE ?? "astra",
    user: env?.pgUser ?? process.env.PG_USER ?? "postgres",
    password: env?.pgPassword ?? process.env.PG_PASSWORD ?? "",
    useSocket: false,
    maxConnections: env?.pgMaxConnections ?? 5,
  });

  // Run migrations (ensures schema is current)
  try {
    await runMigrations();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}  Migration failed: ${msg}${RESET}`);
    console.error(`${DIM}  Continuing with diagnostics anyway...${RESET}\n`);
  }

  // Initialize embeddings if possible (needed for embedding check)
  try {
    const { initEmbeddings } = await import("../memory/embeddings.js");
    initEmbeddings(env?.geminiApiKey);
  } catch {
    // Non-fatal — embedding check will report the failure
  }

  // Initialize Typesense if configured (needed for Typesense checks)
  if (env?.typesenseApiKey) {
    try {
      const { initTypesense } = await import("../config/typesense.js");
      initTypesense({
        port: 8080,
        grokApiKey: env.grokApiKey ?? "",
        nodeEnv: "development",
        jwtSecret: env.jwtSecret,
        jwtAccessExpires: "24h",
        jwtRefreshExpires: "30d",
        typesenseApiKey: env.typesenseApiKey,
        typesenseHost: env.typesenseHost,
        typesensePort: env.typesensePort,
        typesenseProtocol: env.typesenseProtocol,
        geminiApiKey: env.geminiApiKey,
        internalApiKey: env.internalApiKey,
        xBearerToken: env.grokApiKey ?? "",
        allowedOrigins: [],
        grpcPort: 50051,
        grpcEnabled: false,
        pgHost: env.pgHost,
        pgPort: env.pgPort,
        pgDatabase: env.pgDatabase,
        pgUser: env.pgUser,
        pgPassword: env.pgPassword,
        pgUseSocket: false,
        pgMaxConnections: env.pgMaxConnections,
        secretBackend: "env",
        secretTtlSeconds: 300,
        bindJwtToDevice: false,
        memoryTtlDays: 90,
        inferencePayloadTtlDays: 30,
        semanticCacheEnabled: false,
        memoryBackendTimeoutMs: 500,
        piiDetectionPolicy: "redact" as const,
        codeExecSandbox: "process" as const,
        codeExecTimeoutMs: 10000,
        codeExecMemoryLimitMb: 128,
        codeExecDockerImage: "node:20-alpine",
        userRateLimitRpm: 60,
        userRateLimitBurst: 10,
        localDev: false,
        promptInjectionPolicy: "warn" as const,
        watermarkEnabled: false,
        warmPoolSize: 3,
        pgStandbyPort: 5432,
        pgFailoverEnabled: false,
        otelExportEnabled: false,
        zapierEnabled: false,
        jiraEnabled: false,
        costAnomalyThreshold: 3,
        pgReplicaPort: 5432,
        meshGossipEnabled: false,
        sanityDataset: "production",
        latencyTrendAlertThreshold: 50,
        cacheInvalidationBusEnabled: false,
        cacheCompressionEnabled: false,
        cacheCompressionThresholdBytes: 1024,
        mlCacheWarmingEnabled: false,
        cacheStreamingEnabled: false,
        requestCoalescingEnabled: false,
        tokenPredictionEnabled: false,
        adaptiveBatchingEnabled: false,
        extendedThinkingEnabled: false,
      });
    } catch {
      // Non-fatal — Typesense checks will report the failure
    }
  }

  console.log(`${DIM}  [init] Running diagnostics...${RESET}\n`);

  // Run diagnostics
  const { runDiagnostics, persistDiagnosticRun } = await import("../diagnostics/index.js");
  const result = await runDiagnostics();

  // Print results
  printResults(result);

  // Persist to database (best-effort)
  try {
    await persistDiagnosticRun(result);
    console.log(`${DIM}  Diagnostic run saved to database.${RESET}\n`);
  } catch {
    // Non-fatal — the table might not exist if migrations failed
  }

  // Cleanup
  await closePool();

  // Exit with appropriate code
  process.exit(result.overallStatus === "healthy" ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
