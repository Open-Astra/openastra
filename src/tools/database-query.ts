import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

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

// Table allowlist — same as sql-query.ts. Only these tables are accessible.
const ALLOWED_TABLES = new Set([
  "daily_memories",
  "graph_entities",
  "graph_edges",
  "procedural_memory",
  "session_messages",
  "workspace_members",
  "tool_tasks",
  "skill_metrics",
  "sessions",
  "agent_configs",
  "billing_usage",
]);

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
    "Execute a read-only SQL query against the Astra PostgreSQL database. Only SELECT statements are allowed — INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, and other write operations are blocked. Uses database-level read-only transaction enforcement. Supports parameterized queries.",
  parameters: DatabaseQueryParams,
  async execute(params) {
    // Strip comments and normalize whitespace for safety check
    const normalized = params.query
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();

    // First line of defense: regex-based blocklist
    for (const pattern of BLOCKED_STATEMENTS) {
      if (pattern.test(normalized)) {
        return {
          error: "Only SELECT queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE) are blocked for safety.",
        };
      }
    }

    // Ensure the query starts with SELECT only. CTEs (WITH) are blocked because
    // their inner bodies bypass the FROM/JOIN table allowlist check below.
    const firstWord = normalized.split(/\s+/)[0]?.toUpperCase();
    if (firstWord !== "SELECT") {
      return {
        error: `Only SELECT queries are allowed. Got: ${firstWord}`,
      };
    }

    // Check for dangerous functions that can bypass table-level restrictions
    for (const pattern of BLOCKED_FUNCTIONS) {
      if (pattern.test(normalized)) {
        return { error: `Query contains a blocked function: ${pattern.source}` };
      }
    }

    // Reject double-quoted identifiers — they bypass the table regex
    if (/"[^"]+"/.test(normalized)) {
      return { error: "Double-quoted identifiers are not allowed" };
    }

    // Table allowlist: extract table names from FROM/JOIN and validate
    const tablePattern = /\b(?:FROM|JOIN)\s+(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
    let tableMatch: RegExpExecArray | null;
    const referencedTables: string[] = [];

    while ((tableMatch = tablePattern.exec(normalized)) !== null) {
      const schema = tableMatch[1]?.toLowerCase();
      const tableName = tableMatch[2]!.toLowerCase();

      if (schema && BLOCKED_SCHEMAS.has(schema)) {
        return { error: `Schema "${schema}" is not accessible` };
      }

      referencedTables.push(tableName);
      if (!ALLOWED_TABLES.has(tableName)) {
        return {
          error: `Table "${tableName}" is not in the allowed table list. Allowed: ${[...ALLOWED_TABLES].join(", ")}`,
        };
      }
    }

    if (referencedTables.length === 0) {
      return { error: "Query must reference at least one table via FROM or JOIN" };
    }

    // Second line of defense: database-level read-only enforcement
    // Acquire a dedicated client from the pool so we can set transaction mode.
    const pool = getPool();
    const client = await pool.connect();

    try {
      // Set a statement timeout to prevent long-running queries
      await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);

      // Begin a READ ONLY transaction — Postgres will reject any
      // write attempt at the engine level, regardless of SQL tricks.
      await client.query("BEGIN TRANSACTION READ ONLY");

      const result = await client.query(
        params.query,
        params.params as unknown[] | undefined,
      );

      await client.query("COMMIT");

      const rows = result.rows.slice(0, MAX_ROWS);
      const fields = result.fields.map((f) => f.name);
      const truncated = result.rowCount != null && result.rowCount > MAX_ROWS;

      return {
        rows,
        rowCount: result.rowCount ?? 0,
        fields,
        truncated,
        ...(truncated ? { message: `Results truncated to ${MAX_ROWS} rows` } : {}),
      };
    } catch (err) {
      // Rollback on any error (including read-only violations)
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }

      const msg = err instanceof Error ? err.message : String(err);

      // Provide a clear message for read-only violations
      if (msg.includes("read-only transaction")) {
        return {
          error: "Query attempted a write operation, which is blocked. Only read-only SELECT queries are permitted.",
        };
      }

      return { error: msg };
    } finally {
      // Always release the client back to the pool
      client.release();
    }
  },
});
