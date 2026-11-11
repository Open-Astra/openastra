import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { guardSelect, runGuardedSelect, SQL_ALLOWED_TABLES } from "./sql-guard.js";

// ── database_query ────────────────────────────────────────────────────
// Execute read-only SQL queries against the Astra Postgres database.
// Uses SET TRANSACTION READ ONLY for enforced read-only mode at the
// database level, not just regex-based filtering.

const DatabaseQueryParams = z.object({
  query: z.string().min(1).describe("SQL SELECT query to execute"),
  params: z
    .array(z.unknown())
    .optional()
    .describe("Optional parameterized query values ($1, $2, etc.)"),
});

// Table allowlist + tenant scoping live in sql-guard.ts (shared with sql-query).
const ALLOWED_TABLES = new Set<string>(SQL_ALLOWED_TABLES);

// Block access to system catalogs via schema-qualified names
const BLOCKED_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "pg_temp",
]);

// Dangerous functions that can exfiltrate data without table references
const BLOCKED_FUNCTIONS = [
  /\bpg_read_file\b/i,
  /\bpg_read_binary_file\b/i,
  /\bpg_ls_dir\b/i,
  /\blo_get\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bdblink\b/i,
  /\bdblink_exec\b/i,
  /\bpg_exec\b/i,
];

// Patterns that indicate a write/DDL operation — first line of defense
// before the database-level read-only enforcement catches anything else.
const BLOCKED_STATEMENTS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCOPY\b/i,
  /\bEXECUTE\b/i,
  /\bCALL\b/i,
  /\bSET\b\s/i,
  /\bDO\b\s*\$/i, // DO $$ blocks (PL/pgSQL)
  /\bSELECT\b.*\bINTO\b/i, // SELECT INTO (creates table)
  /\bLOCK\b/i,
  /\bDISCARD\b/i,
  /\bCOMMENT\b\s+ON\b/i,
  /\bNOTIFY\b/i,
  /\bLISTEN\b/i,
  /\bLOAD\b\s/i,
  /\bPREPARE\b/i,
  /\bDEALLOCATE\b/i,
  /\bRESET\b/i,
];

const MAX_ROWS = 500;
const QUERY_TIMEOUT_MS = 15_000; // 15s statement timeout

registerTool({
  name: "database_query",
  description:
    `Execute a read-only SQL SELECT against your own data in the Astra PostgreSQL database. One table per query (no joins, subqueries, CTEs or comments); rows are automatically restricted to the calling user/workspace. Supports parameterized queries. Tables: ${[...ALLOWED_TABLES].join(", ")}.`,
  parameters: DatabaseQueryParams,
  async execute(params, ctx) {
    // First line of defense: keyword blocklists (cheap, clear errors).
    for (const pattern of [...BLOCKED_STATEMENTS, ...BLOCKED_FUNCTIONS]) {
      if (pattern.test(params.query)) {
        return {
          error: "Only single-table SELECT queries are allowed. Write operations and server-side file/network functions are blocked.",
        };
      }
    }
    for (const schema of BLOCKED_SCHEMAS) {
      if (new RegExp(`\\b${schema}\\b`, "i").test(params.query)) {
        return { error: `Schema "${schema}" is not accessible` };
      }
    }

    // Structural validation + tenant scoping. The validated, rewritten SQL
    // is what gets executed — never the caller's original text.
    const guarded = guardSelect(
      params.query,
      params.params as unknown[] | undefined,
      { uid: ctx?.uid, workspaceId: ctx?.workspaceId },
      { limit: MAX_ROWS, maxLimit: MAX_ROWS },
    );
    if (!guarded.ok) {
      return { error: guarded.error };
    }

    // Second line of defense: database-level read-only enforcement.
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await runGuardedSelect(client, guarded, QUERY_TIMEOUT_MS);
      const rows = result.rows.slice(0, MAX_ROWS);
      const truncated = result.rows.length > MAX_ROWS;
      return {
        rows,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => f.name),
        truncated,
        ...(truncated ? { message: `Results truncated to ${MAX_ROWS} rows` } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("read-only transaction")) {
        return {
          error: "Query attempted a write operation, which is blocked. Only read-only SELECT queries are permitted.",
        };
      }
      return { error: msg };
    } finally {
      client.release();
    }
  },
});

export const _testOnly = { ALLOWED_TABLES, BLOCKED_SCHEMAS, BLOCKED_FUNCTIONS, BLOCKED_STATEMENTS };
