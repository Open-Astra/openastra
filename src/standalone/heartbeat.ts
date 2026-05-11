#!/usr/bin/env node

// ── Astra Heartbeat CLI ──────────────────────────────────────────────
// Displays recent heartbeat monitor results in the terminal.
// Usage:
//   npx astra heartbeat
//   npx astra heartbeat --limit 50
//   npx astra heartbeat --config <uuid>

import { loadStandaloneEnv } from "./env.js";
import { initPostgres, closePool, getPool } from "../config/postgres.js";
import { initJwt } from "../auth/jwt.js";
import { runMigrations } from "../db/migrate.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function statusColor(status: string): string {
  switch (status) {
    case "ok": return `${GREEN}ok${RESET}`;
    case "changed": return `${YELLOW}changed${RESET}`;
    case "error": return `${RED}error${RESET}`;
    case "timeout": return `${RED}timeout${RESET}`;
    default: return status;
  }
}

function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(`  ${DIM}(no data)${RESET}`);
    return;
  }

  const widths = headers.map((h, i) => {
    const stripped = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const dataMax = rows.reduce((max, row) => Math.max(max, stripped(row[i] ?? "").length), 0);
    return Math.max(h.length, dataMax);
  });

  const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join("  ");
  console.log(`  ${BOLD}${headerLine}${RESET}`);

  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(`  ${DIM}${separator}${RESET}`);

  for (const row of rows) {
    const stripped = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const line = row.map((cell, i) => {
      const pad = widths[i]! - stripped(cell).length;
      return cell + " ".repeat(Math.max(0, pad));
    }).join("  ");
    console.log(`  ${line}`);
  }
}

async function main(): Promise<void> {
  const env = loadStandaloneEnv();

  let limit = 20;
  let configFilter: string | null = null;
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
      i++;
    } else if (args[i] === "--config" && args[i + 1]) {
      configFilter = args[i + 1]!;
      i++;
    } else if (args[i] === "--help") {
      console.log(`
${BOLD}Astra Heartbeat Monitor${RESET}

${BOLD}Usage:${RESET}
  npx astra heartbeat [options]

${BOLD}Options:${RESET}
  --limit <n>      Number of runs to show (default: 20)
  --config <uuid>  Filter by config ID
  --help           Show this help message
`);
      process.exit(0);
    }
  }

  console.log(`${DIM}  Connecting to database...${RESET}`);

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

  const pool = getPool();

  // List configs
  const { rows: configs } = await pool.query(
    `SELECT id, name, type, interval_minutes, enabled, last_run_at FROM heartbeat_configs ORDER BY created_at DESC`,
  );

  console.log();
  console.log(`${BOLD}${CYAN}  Astra Heartbeat Monitor${RESET}`);
  console.log(`${DIM}  ${"=".repeat(50)}${RESET}`);
  console.log();

  if (configs.length === 0) {
    console.log(`  ${YELLOW}No heartbeat configs found.${RESET}`);
    console.log(`  ${DIM}Add heartbeats to astra.yml or use POST /heartbeat.${RESET}`);
    console.log();
    await closePool();
    process.exit(0);
  }

  console.log(`  ${BOLD}Configured Heartbeats (${configs.length})${RESET}`);
  printTable(
    ["Name", "Type", "Interval", "Enabled", "Last Run"],
    configs.map((c) => [
      c.name as string,
      c.type as string,
      `${c.interval_minutes}m`,
      c.enabled ? `${GREEN}yes${RESET}` : `${DIM}no${RESET}`,
      c.last_run_at ? new Date(c.last_run_at as string).toLocaleString() : `${DIM}never${RESET}`,
    ]),
  );
  console.log();

  // Recent runs
  const query = configFilter
    ? `SELECT r.*, c.name AS config_name
       FROM heartbeat_runs r
       JOIN heartbeat_configs c ON c.id = r.config_id
       WHERE r.config_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`
    : `SELECT r.*, c.name AS config_name
       FROM heartbeat_runs r
       JOIN heartbeat_configs c ON c.id = r.config_id
       ORDER BY r.created_at DESC
       LIMIT $1`;

  const { rows: runs } = configFilter
    ? await pool.query(query, [configFilter, limit])
    : await pool.query(query, [limit]);

  console.log(`  ${BOLD}Recent Runs (last ${limit})${RESET}`);

  if (runs.length === 0) {
    console.log(`  ${DIM}No runs yet. Wait for the cron to fire or check your config.${RESET}`);
    console.log();
  } else {
    printTable(
      ["Config", "Status", "Duration", "Summary", "Time"],
      runs.map((r) => [
        r.config_name as string,
        statusColor(r.status as string),
        r.duration_ms ? `${r.duration_ms}ms` : "-",
        ((r.agent_summary as string | null) ?? "").slice(0, 60),
        new Date(r.created_at as string).toLocaleString(),
      ]),
    );
    console.log();
  }

  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\x1b[31mFatal: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
