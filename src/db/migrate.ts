import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../config/postgres.js";

// ── Migration Runner ──────────────────────────────────────────────
// Reads SQL files from src/db/migrations/ in alphabetical order.
// Tracks applied migrations in the schema_migrations table.
// Idempotent: safe to run on every startup.

const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "migrations",
);

// Arbitrary but stable 64-bit key for pg_advisory_lock — serialises the
// migration run across gateway replicas starting at the same time.
const MIGRATION_LOCK_KEY = "7239017465120931";

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();

  // Hold a session-level advisory lock on a dedicated connection for the whole
  // run. A second replica blocks here, then finds everything already applied.
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    return await runMigrationsLocked(pool);
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    } catch {
      // Connection lost — the session lock is released by Postgres anyway.
    }
    lockClient.release();
  }
}

async function runMigrationsLocked(pool: ReturnType<typeof getPool>): Promise<string[]> {

  // Ensure the schema_migrations table exists (bootstrap)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const { rows: applied } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  // Read migration files
  let files: string[];
  try {
    files = await readdir(MIGRATIONS_DIR);
  } catch {
    console.warn("[migrate] No migrations directory found");
    return [];
  }

  const sqlFiles = files
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newMigrations: string[] = [];

  for (const file of sqlFiles) {
    if (appliedSet.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Migrations may build indexes; do not let the pool-wide 30s
      // statement_timeout kill them half-way.
      await client.query("SET LOCAL statement_timeout = 0");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      newMigrations.push(file);
      if (!process.env.ASTRA_STANDALONE) console.log(`[migrate] Applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[migrate] Failed on ${file}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (!process.env.ASTRA_STANDALONE) {
    if (newMigrations.length === 0) {
      console.log("[migrate] All migrations up to date");
    } else {
      console.log(`[migrate] Applied ${newMigrations.length} migration(s)`);
    }
  }

  // Warm up HNSW indexes in production to load them into shared_buffers
  if (process.env.NODE_ENV === "production") {
    try {
      // Discover the vector indexes that actually exist instead of guessing names.
      const { rows: vectorIndexes } = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND (indexdef ILIKE '%USING hnsw%' OR indexdef ILIKE '%USING ivfflat%')`,
      );
      for (const { indexname } of vectorIndexes) {
        await pool.query(`SELECT pg_prewarm($1::regclass)`, [indexname]).catch(() => {});
      }
      if (!process.env.ASTRA_STANDALONE) console.log("[migrate] Warmed HNSW indexes");
    } catch {
      // pg_prewarm may not be available in all PG versions — skip silently
    }
  }

  return newMigrations;
}
