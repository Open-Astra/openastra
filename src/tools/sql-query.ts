import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { recordThreat } from "../security/intrusion-detection.js";
import { guardSelect, runGuardedSelect, SQL_ALLOWED_TABLES } from "./sql-guard.js";

const log = createLogger("sql-query");

// ── sql-query Tool ───────────────────────────────────────────────────
// Safe read-only SQL query tool with table allowlist.
// Prevents SQL injection and write operations via pattern matching
// and structural query validation.

// Tables are defined (with their tenant-scoping predicate) in sql-guard.ts.
const ALLOWED_TABLES = new Set<string>(SQL_ALLOWED_TABLES);

// Schema-qualified access to system catalogs must be blocked explicitly —
// the table allowlist alone won't catch `information_schema.tables` because
// the regex previously only captured the first identifier token.
const BLOCKED_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "pg_temp",
]);

const FORBIDDEN_PATTERNS = [
  /\bDROP\b/i,
  /\bDELETE\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bTRUNCATE\b/i,
  /\bCREATE\b/i,
  /\bALTER\b/i,
  /\bEXECUTE\b/i,
  /\bEXEC\b/i,
  /\bEXPLAIN\b/i,
  /\bCOPY\b/i,
  /\\copy\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bpg_read_file\b/i,
  /\bpg_ls_dir\b/i,
  /\bpg_stat_file\b/i,
  /\bpg_exec\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bdblink\b/i,
  /\bpg_connect\b/i,
  /\bSET\b/i,
];

const Params = z.object({
  query: z.string().max(2000).describe("SQL SELECT query"),
  params: z.array(z.unknown()).optional().describe("Query parameters ($1, $2...)"),
  limit: z.number().min(1).max(1000).optional().default(100).describe("Max rows returned"),
});

registerTool({
  name: "sql-query",
  description:
    `Run a read-only SQL SELECT against your own data in the Astra database. One table per query (no joins, subqueries, CTEs or comments); results are automatically limited to rows that belong to you. Tables: ${[...ALLOWED_TABLES].join(", ")}.`,
  parameters: Params,
  async execute(params, ctx) {
    const { query, params: queryParams, limit } = params;

    // Step 1: keyword screen (kept for threat telemetry; the structural
    // validator below is what actually enforces the rules).
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(query)) {
        recordThreat({ category: "sqli", sourceIp: "unknown", uid: ctx?.uid, detail: `forbidden SQL pattern: ${pattern.source}`, timestamp: Date.now() });
        return { error: `Query contains a forbidden keyword or pattern: ${pattern.source}` };
      }
    }

    // Step 2: structural validation + tenant scoping. The SQL returned here
    // is rebuilt from the validated tokens and is exactly what gets executed.
    const guarded = guardSelect(
      query,
      queryParams,
      { uid: ctx?.uid, workspaceId: ctx?.workspaceId },
      { limit, maxLimit: 1000 },
    );
    if (!guarded.ok) {
      recordThreat({ category: "sqli", sourceIp: "unknown", uid: ctx?.uid, detail: `rejected SQL: ${guarded.error}`, timestamp: Date.now() });
      return { error: guarded.error };
    }

    log.dim(`sql-query: ${guarded.table} → ${guarded.sql.slice(0, 80)}...`);

    // Step 3: Execute in a READ ONLY transaction (defense-in-depth)
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await runGuardedSelect(client, guarded, 10_000);
      return { rows: result.rows, rowCount: result.rowCount, fields: result.fields };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("read-only transaction")) {
        return { error: "Query attempted a write operation, which is blocked." };
      }
      return { error: msg };
    } finally {
      client.release();
    }
  },
});

export const _testOnly = { ALLOWED_TABLES, BLOCKED_SCHEMAS, FORBIDDEN_PATTERNS };
