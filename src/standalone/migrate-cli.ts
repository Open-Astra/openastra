import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPool } from "../config/postgres.js";

// ── Migration CLI ──────────────────────────────────────────────────
// `astra migrate` — manage database migrations from the CLI.
//
// Subcommands:
//   up       — apply all pending migrations (default)
//   down     — rollback the last N migrations
//   status   — show applied vs pending migrations
//   create   — create a new migration file

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const ROOT = join(process.cwd(), "src");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const DATA_MIGRATIONS_DIR = join(ROOT, "data", "migrations");

// ── Helpers ────────────────────────────────────────────────────────

async function getApplied(): Promise<Set<string>> {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    return new Set(rows.map((r: { version: string }) => r.version));
  } catch {
    return new Set();
  }
}

async function getMigrationFiles(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((f: string) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

// ── Subcommands ────────────────────────────────────────────────────

async function migrateUp(dryRun: boolean): Promise<void> {
  const pool = getPool();
  const applied = await getApplied();

  const schemaMigrations = await getMigrationFiles(MIGRATIONS_DIR);
  const dataMigrations = await getMigrationFiles(DATA_MIGRATIONS_DIR);

  const allPending = [
    ...schemaMigrations.filter((f) => !applied.has(f)).map((f) => ({ file: f, dir: MIGRATIONS_DIR, type: "schema" })),
    ...dataMigrations.filter((f) => !applied.has(f)).map((f) => ({ file: f, dir: DATA_MIGRATIONS_DIR, type: "data" })),
  ].sort((a, b) => a.file.localeCompare(b.file));

  if (allPending.length === 0) {
    console.log(`  ${GREEN}✓${RESET} All migrations up to date (${applied.size} applied)`);
    return;
  }

  console.log(`  Found ${allPending.length} pending migration(s)\n`);

  if (dryRun) {
    console.log(`  ${YELLOW}DRY RUN — no changes will be applied${RESET}\n`);
  }

  for (const { file, dir, type } of allPending) {
    if (dryRun) {
      console.log(`  ${DIM}[dry-run]${RESET} Would apply: ${file} (${type})`);
      continue;
    }

    const sql = await readFile(join(dir, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      console.log(`  ${GREEN}✓${RESET} Applied: ${file} (${type})`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.log(`  ${RED}✗${RESET} Failed: ${file}`);
      console.log(`    ${RED}${err instanceof Error ? err.message : err}${RESET}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  if (!dryRun) {
    console.log(`\n  ${GREEN}✓${RESET} Applied ${allPending.length} migration(s)`);
  }
}

async function migrateStatus(): Promise<void> {
  const applied = await getApplied();
  const schemaMigrations = await getMigrationFiles(MIGRATIONS_DIR);
  const dataMigrations = await getMigrationFiles(DATA_MIGRATIONS_DIR);
  const allFiles = [...schemaMigrations, ...dataMigrations].sort();

  console.log(`\n  ${BOLD}Migration Status${RESET}\n`);

  const appliedArr = [...applied].sort();
  const pending = allFiles.filter((f) => !applied.has(f));

  // Show last 10 applied
  if (appliedArr.length > 0) {
    console.log(`  ${GREEN}Applied (${appliedArr.length}):${RESET}`);
    const recent = appliedArr.slice(-10);
    if (appliedArr.length > 10) {
      console.log(`    ${DIM}... ${appliedArr.length - 10} earlier migration(s)${RESET}`);
    }
    for (const f of recent) {
      console.log(`    ${GREEN}✓${RESET} ${f}`);
    }
    console.log();
  }

  // Show pending
  if (pending.length > 0) {
    console.log(`  ${YELLOW}Pending (${pending.length}):${RESET}`);
    for (const f of pending) {
      console.log(`    ${YELLOW}○${RESET} ${f}`);
    }
    console.log();
  }

  // Orphans (applied but no file)
  const orphans = appliedArr.filter((f) => !allFiles.includes(f));
  if (orphans.length > 0) {
    console.log(`  ${RED}Orphaned (applied but file missing):${RESET}`);
    for (const f of orphans) {
      console.log(`    ${RED}!${RESET} ${f}`);
    }
    console.log();
  }

  console.log(`  ${DIM}Total: ${allFiles.length} files, ${applied.size} applied, ${pending.length} pending${RESET}\n`);
}

async function migrateCreate(name: string): Promise<void> {
  if (!name) {
    console.log(`  ${RED}Please provide a migration name${RESET}`);
    console.log(`  ${DIM}Example: npx astra migrate create add-user-preferences${RESET}`);
    process.exit(1);
  }

  // Validate name
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    console.log(`  ${RED}Invalid name: use lowercase letters, numbers, hyphens, underscores${RESET}`);
    process.exit(1);
  }

  // Get next sequence number
  const existing = await getMigrationFiles(MIGRATIONS_DIR);
  const lastNum = existing.reduce((max, f) => {
    const match = f.match(/^(\d+)/);
    return match ? Math.max(max, parseInt(match[1]!, 10)) : max;
  }, 0);

  const seq = String(lastNum + 1).padStart(3, "0");
  const filename = `${seq}-${name}.sql`;
  const filepath = join(MIGRATIONS_DIR, filename);

  const template = `-- Migration: ${filename}
-- Created: ${new Date().toISOString()}

-- ── Up ────────────────────────────────────────────────────────────

-- TODO: Add your migration SQL here

-- Example:
-- CREATE TABLE user_preferences (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   uid TEXT NOT NULL,
--   key TEXT NOT NULL,
--   value JSONB NOT NULL DEFAULT '{}',
--   created_at TIMESTAMPTZ DEFAULT NOW(),
--   UNIQUE(uid, key)
-- );
`;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(filepath, template);
  console.log(`  ${GREEN}✓${RESET} Created: src/db/migrations/${filename}`);
}

// ── Main ───────────────────────────────────────────────────────────

export async function runMigrate(): Promise<void> {
  const args = process.argv.slice(2).filter((a: string) => a !== "migrate");
  const subcommand = args[0] ?? "up";
  const dryRun = args.includes("--dry-run");

  // Ensure schema_migrations table exists
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  switch (subcommand) {
    case "up":
      console.log(`\n${BOLD}  Running Migrations${RESET}\n`);
      await migrateUp(dryRun);
      break;

    case "status":
      await migrateStatus();
      break;

    case "create":
      await migrateCreate(args[1] ?? "");
      break;

    case "help":
      printUsage();
      break;

    default:
      console.log(`${RED}Unknown migrate subcommand: ${subcommand}${RESET}`);
      printUsage();
      process.exit(1);
  }

  process.exit(0);
}

function printUsage(): void {
  console.log(`
${BOLD}Usage:${RESET}
  npx astra migrate [subcommand] [options]

${BOLD}Subcommands:${RESET}
  ${CYAN}up${RESET}         Apply all pending migrations ${DIM}(default)${RESET}
  ${CYAN}status${RESET}     Show applied vs pending migrations
  ${CYAN}create${RESET}     Create a new migration file

${BOLD}Options:${RESET}
  ${CYAN}--dry-run${RESET}  Preview changes without applying

${BOLD}Examples:${RESET}
  ${DIM}$${RESET} npx astra migrate                  ${DIM}# Apply pending${RESET}
  ${DIM}$${RESET} npx astra migrate status            ${DIM}# Check status${RESET}
  ${DIM}$${RESET} npx astra migrate up --dry-run      ${DIM}# Preview${RESET}
  ${DIM}$${RESET} npx astra migrate create add-tags   ${DIM}# New migration${RESET}
`);
}
