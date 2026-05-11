import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { recordThreat } from "../security/intrusion-detection.js";

const log = createLogger("sql-query");

// ── sql-query Tool ───────────────────────────────────────────────────
// Safe read-only SQL query tool with table allowlist.
// Prevents SQL injection and write operations via pattern matching
// and structural query validation.

const ALLOWED_TABLES = new Set([
  "daily_memories",
  "graph_entities",
  "graph_edges",
  "procedural_memory",
  "session_messages",
  "workspace_members",
  "tool_tasks",
  "skill_metrics",
]);

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
    "Run a read-only SQL SELECT query against the Astra database. Restricted to an approved set of tables: daily_memories, graph_entities, graph_edges, procedural_memory, session_messages, workspace_members, tool_tasks, skill_metrics. Write operations and dangerous patterns are blocked.",
  parameters: Params,
  async execute(params, ctx) {
    const { query, params: queryParams, limit } = params;

    // Step 1: Check forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(query)) {
        recordThreat({ category: "sqli", sourceIp: "unknown", uid: ctx?.uid, detail: `forbidden SQL pattern: ${pattern.source}`, timestamp: Date.now() });
        return { error: `Query contains a forbidden keyword or pattern: ${pattern.source}` };
      }
    }

    // Step 2: Strip SQL comments and verify starts with SELECT
    const stripped = query
      .replace(/--[^\n]*/g, " ")       // strip single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, " ") // strip block comments
      .trim();

    if (!/^SELECT\b/i.test(stripped)) {
      return { error: "Only SELECT queries are allowed" };
    }

    // Step 3: Reject double-quoted identifiers — they bypass the table regex
    if (/"[^"]+"/.test(stripped)) {
      return { error: "Double-quoted identifiers are not allowed" };
    }

    // Step 3b: Block subqueries — they can reference disallowed tables
    if (/\(\s*SELECT\b/i.test(stripped)) {
      return { error: "Subqueries are not allowed" };
    }

    // Step 3c: Extract ALL identifiers from FROM clauses (including comma-joins)
    // and validate against the allowlist.
    const referencedTables: string[] = [];

    // Match FROM ... until WHERE/ORDER/GROUP/HAVING/LIMIT/;/end or next keyword
    const fromClausePattern = /\bFROM\s+([\s\S]*?)(?=\bWHERE\b|\bORDER\b|\bGROUP\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|;|$)/gi;
    let fromMatch: RegExpExecArray | null;

    while ((fromMatch = fromClausePattern.exec(stripped)) !== null) {
      const fromClause = fromMatch[1]!;
      // Extract each table reference (handles comma-separated and JOIN)
      const tableTokenPattern = /(?:^|,|\bJOIN)\s*(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
      let tableMatch: RegExpExecArray | null;

      while ((tableMatch = tableTokenPattern.exec(fromClause)) !== null) {
        const schema = tableMatch[1]?.toLowerCase();
        const tableName = tableMatch[2]!.toLowerCase();

        if (schema && BLOCKED_SCHEMAS.has(schema)) {
          return { error: `Schema "${schema}" is not accessible` };
        }

        // Skip SQL keywords that appear in FROM clauses
        const KEYWORDS = new Set(["on", "as", "using", "inner", "outer", "left", "right", "cross", "natural", "full", "lateral"]);
        if (KEYWORDS.has(tableName)) continue;

        referencedTables.push(tableName);
        if (!ALLOWED_TABLES.has(tableName)) {
          return {
            error: `Table "${tableName}" is not in the allowed table list. Allowed: ${[...ALLOWED_TABLES].join(", ")}`,
          };
        }
      }
    }

    if (referencedTables.length === 0) {
      return { error: "Query must reference at least one table via FROM or JOIN" };
    }

    // Step 4: Append LIMIT if not present
    let finalQuery = stripped;
    if (!/\bLIMIT\b/i.test(finalQuery)) {
      finalQuery = `${finalQuery} LIMIT ${limit}`;
    }

    log.dim(`sql-query: ${referencedTables.join(", ")} → ${finalQuery.slice(0, 80)}...`);

    // Step 5: Execute in a READ ONLY transaction (defense-in-depth)
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '10s'");
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(finalQuery, queryParams ?? []);
      await client.query("COMMIT");

      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        fields: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataTypeID: f.dataTypeID,
        })),
      };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
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
