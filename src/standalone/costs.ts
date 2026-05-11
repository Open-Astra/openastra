#!/usr/bin/env node

// ── Astra Cost Dashboard CLI ────────────────────────────────────────
// Displays workspace cost breakdowns in the terminal.
// Usage:
//   npm run costs
//   npx astra costs

import { loadStandaloneEnv } from "./env.js";
import { initPostgres, closePool } from "../config/postgres.js";
import { initJwt } from "../auth/jwt.js";
import { runMigrations } from "../db/migrate.js";
import { getWorkspaceCostBreakdown } from "../billing/cost-dashboard.js";
import type { CostBreakdown } from "../billing/cost-dashboard.js";

// ── ANSI Helpers ────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

// ── Formatting Helpers ──────────────────────────────────────────────

function formatCost(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toLocaleString();
}

function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(`  ${DIM}(no data)${RESET}`);
    return;
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), 0);
    return Math.max(h.length, dataMax);
  });

  // Header row
  const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join("  ");
  console.log(`  ${BOLD}${headerLine}${RESET}`);

  // Separator
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(`  ${DIM}${separator}${RESET}`);

  // Data rows
  for (const row of rows) {
    const line = row.map((cell, i) => {
      // Right-align numeric columns (everything except the first column)
      if (i > 0) {
        return cell.padStart(widths[i]!);
      }
      return cell.padEnd(widths[i]!);
    }).join("  ");
    console.log(`  ${line}`);
  }
}

function printBarChart(items: Array<{ label: string; value: number }>): void {
  if (items.length === 0) {
    console.log(`  ${DIM}(no data)${RESET}`);
    return;
  }

  const maxValue = Math.max(...items.map((i) => i.value));
  const maxBarWidth = 30;

  for (const item of items) {
    const barLen = maxValue > 0 ? Math.round((item.value / maxValue) * maxBarWidth) : 0;
    const bar = "\u2588".repeat(barLen);
    const cost = formatCost(item.value);
    console.log(`  ${item.label}  ${CYAN}${bar}${RESET} ${cost}`);
  }
}

// ── Dashboard Output ────────────────────────────────────────────────

function printDashboard(breakdown: CostBreakdown): void {
  console.log();
  console.log(`${BOLD}${CYAN}  Astra Cost Dashboard${RESET}`);
  console.log(`${DIM}  ${"=".repeat(50)}${RESET}`);
  console.log();

  // Summary
  console.log(`  ${BOLD}Summary${RESET}`);
  console.log(`  Total tokens: ${GREEN}${formatTokens(breakdown.totalTokens)}${RESET}`);
  console.log(`  Total cost:   ${GREEN}${formatCost(breakdown.totalCost)}${RESET}`);
  console.log();

  // By Agent
  if (breakdown.byAgent.length > 0) {
    console.log(`  ${BOLD}Cost by Agent${RESET}`);
    printTable(
      ["Agent", "Tokens", "Cost"],
      breakdown.byAgent.map((a) => [a.agentId, formatTokens(a.tokens), formatCost(a.cost)]),
    );
    console.log();
  }

  // By Model
  if (breakdown.byModel.length > 0) {
    console.log(`  ${BOLD}Cost by Model${RESET}`);
    printTable(
      ["Model", "Tokens", "Cost"],
      breakdown.byModel.map((m) => [m.modelId, formatTokens(m.tokens), formatCost(m.cost)]),
    );
    console.log();
  }

  // By User
  if (breakdown.byUser.length > 0) {
    console.log(`  ${BOLD}Cost by User${RESET}`);
    printTable(
      ["User", "Tokens", "Cost"],
      breakdown.byUser.map((u) => [u.userId, formatTokens(u.tokens), formatCost(u.cost)]),
    );
    console.log();
  }

  // Trend
  if (breakdown.trend.length > 0) {
    console.log(`  ${BOLD}Monthly Trend${RESET}`);
    printBarChart(
      breakdown.trend.map((t) => ({ label: t.period, value: t.cost })),
    );
    console.log();

    // Also show trend as a table for exact numbers
    printTable(
      ["Month", "Tokens", "Cost"],
      breakdown.trend.map((t) => [t.period, formatTokens(t.tokens), formatCost(t.cost)]),
    );
    console.log();
  }

  // No data at all
  if (
    breakdown.totalTokens === 0 &&
    breakdown.byAgent.length === 0 &&
    breakdown.byUser.length === 0
  ) {
    console.log(`  ${YELLOW}No usage data found for the selected period.${RESET}`);
    console.log(`  ${DIM}Start chatting with an agent to begin tracking costs.${RESET}`);
    console.log();
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const env = loadStandaloneEnv();

  // Parse --months flag
  let months = 3;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--months" && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!isNaN(parsed) && parsed > 0) {
        months = parsed;
      }
      i++;
    }
    if (args[i] === "--help") {
      console.log(`
${BOLD}Astra Cost Dashboard${RESET}

${BOLD}Usage:${RESET}
  npm run costs [options]
  npx astra costs [options]

${BOLD}Options:${RESET}
  --months <n>    Number of months to show (default: 3)
  --help          Show this help message
`);
      process.exit(0);
    }
  }

  console.log(`${DIM}  Connecting to database...${RESET}`);

  // Initialize services
  initJwt({
    jwtSecret: env.jwtSecret,
    accessExpires: "24h",
    refreshExpires: "30d",
  });

  initPostgres({
    host: env.pgHost,
    port: env.pgPort,
    database: env.pgDatabase,
    user: env.pgUser,
    password: env.pgPassword,
    useSocket: false,
    maxConnections: env.pgMaxConnections,
  });

  await runMigrations();

  // Fetch cost breakdown (null = all workspaces)
  const breakdown = await getWorkspaceCostBreakdown(null, { months });

  printDashboard(breakdown);

  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  process.exit(1);
});
