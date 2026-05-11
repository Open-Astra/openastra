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

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();

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
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      newMigrations.push(file);
      if (!process.env.ASTRA_STANDALONE) console.log(`[migrate] Applied: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
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
    const INDEXES_TO_WARM = [
      "session_messages_embedding_idx",
      "daily_memories_embedding_idx",
      "graph_entities_embedding_idx",
      "procedural_memory_embedding_idx",
    ];

    try {
      for (const idx of INDEXES_TO_WARM) {
        await pool.query(`SELECT pg_prewarm($1)`, [idx]).catch(() => {});
      }
      if (!process.env.ASTRA_STANDALONE) console.log("[migrate] Warmed HNSW indexes");
    } catch {
      // pg_prewarm may not be available in all PG versions — skip silently
    }
  }

  return newMigrations;
}
