import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";
import { guardSelect, runGuardedSelect, SCOPED_TABLES } from "../../../tools/sql-guard.js";

// ── SQL Query Skill ───────────────────────────────────────────────
// Read-only SQL queries against the application's Postgres database.
// Useful for analytics, usage stats, session history, entity counts,
// and ad-hoc data exploration.
//
// Safety: Only SELECT statements are allowed. DML/DDL is rejected.

// Tables this skill exposes. Each must also be defined (with its tenant
// scoping predicate) in tools/sql-guard.ts; anything not defined there is
// dropped, so a table without a sound per-user filter is never queryable.
const ALLOWED_TABLES = new Set(
  [
    "sessions",
    "messages",
    "daily_memory",
    "memory_profiles",
    "billing_usage",
    "graph_entities",
    "graph_edges",
    "procedural_memory",
    "knowledge_store",
    "agent_config_versions",
  ].filter((t) => t in SCOPED_TABLES),
);

const SqlQueryParams = z.object({
  query: z.string().describe("SQL SELECT query to execute (read-only)"),
  limit: z.number().min(1).max(100).optional().describe("Override LIMIT clause (default 25, max 100)"),
});

const TableInfoParams = z.object({
  table: z.string().describe("Table name to describe"),
});

const QuickStatsParams = z.object({
  metric: z.enum([
    "session_count",
    "message_count",
    "memory_entries",
    "graph_entities",
    "graph_edges",
    "procedure_count",
    "token_usage",
  ]).describe("Which metric to retrieve"),
});

const sqlQuerySkill: SkillDefinition = {
  name: "sql_query",
  version: "1.0.0",

  manifest: {
    id: "sql_query",
    name: "SQL Query",
    description: "Read-only SQL queries for analytics and data exploration. Query sessions, messages, memory, billing, and knowledge graph tables.",
    category: "analyze",
    tools: ["sql_query", "sql_table_info", "sql_quick_stats"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "sql_query",
      description: "Execute a read-only SQL SELECT over your own data. One table per query — no joins, subqueries, CTEs or comments. Results are limited to your rows and at most 100 rows.",
      parameters: SqlQueryParams,

      async execute(params, toolCtx) {
        // Structural validation (single statement, single table, no CTEs,
        // subqueries, joins or comments) + rewrite to the caller's own rows.
        // The rewritten SQL is the SQL that runs.
        const guarded = guardSelect(
          params.query,
          undefined,
          { uid: toolCtx?.uid, workspaceId: toolCtx?.workspaceId },
          { limit: params.limit ?? 25, maxLimit: 100, tables: ALLOWED_TABLES },
        );
        if (!guarded.ok) {
          return { error: guarded.error };
        }

        const client = await getPool().connect();
        try {
          const result = await runGuardedSelect(client, guarded, 10_000);
          return {
            success: true,
            rowCount: result.rows.length,
            columns: result.fields.map((f) => f.name),
            rows: result.rows.slice(0, 100),
          };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
            query: params.query,
          };
        } finally {
          client.release();
        }
      },
    });

    ctx.registerTool({
      name: "sql_table_info",
      description: "Describe a table's columns and types. Only application tables are accessible.",
      parameters: TableInfoParams,

      async execute(params) {
        if (!ALLOWED_TABLES.has(params.table)) {
          return {
            error: `Table '${params.table}' is not accessible. Available tables: ${[...ALLOWED_TABLES].join(", ")}`,
          };
        }

        const pool = getPool();
        const { rows } = await pool.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'
           ORDER BY ordinal_position`,
          [params.table],
        );

        return {
          table: params.table,
          columnCount: rows.length,
          columns: rows.map((r) => ({
            name: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable === "YES",
            default: r.column_default,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "sql_quick_stats",
      description: "Get quick statistics about the system. Provides pre-built queries for common metrics.",
      parameters: QuickStatsParams,

      async execute(params, toolCtx) {
        const pool = getPool();
        const uid = toolCtx.uid;

        const queries: Record<string, { sql: string; params: unknown[] }> = {
          session_count: {
            sql: `SELECT status, COUNT(*) as count FROM sessions WHERE user_id = $1 GROUP BY status`,
            params: [uid],
          },
          message_count: {
            sql: `SELECT COUNT(*) as total, COUNT(DISTINCT session_id) as sessions FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.user_id = $1`,
            params: [uid],
          },
          memory_entries: {
            sql: `SELECT date, jsonb_array_length(entries) as entry_count FROM daily_memory WHERE user_id = $1 ORDER BY date DESC LIMIT 14`,
            params: [uid],
          },
          graph_entities: {
            sql: `SELECT type, COUNT(*) as count, AVG(reinforcement_score)::numeric(5,3) as avg_score FROM graph_entities WHERE uid = $1 GROUP BY type ORDER BY count DESC`,
            params: [uid],
          },
          graph_edges: {
            sql: `SELECT type, COUNT(*) as count, AVG(weight)::numeric(5,3) as avg_weight FROM graph_edges WHERE uid = $1 GROUP BY type ORDER BY count DESC`,
            params: [uid],
          },
          procedure_count: {
            sql: `SELECT type, COUNT(*) as count, SUM(execution_count) as total_executions, AVG(CASE WHEN execution_count > 0 THEN success_count::float / execution_count END)::numeric(5,3) as avg_success_rate FROM procedural_memory WHERE user_id = $1 GROUP BY type`,
            params: [uid],
          },
          token_usage: {
            sql: `SELECT month, total_tokens, total_prompt_tokens, total_completion_tokens, request_count FROM billing_usage WHERE user_id = $1 ORDER BY month DESC LIMIT 3`,
            params: [uid],
          },
        };

        const q = queries[params.metric]!;
        const { rows } = await pool.query(q.sql, q.params);

        return {
          metric: params.metric,
          data: rows,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "sql_query",
      instructions:
        "You can query your own data with `sql_query` (read-only, single-table SELECT), inspect table schemas with `sql_table_info`, and get quick metrics with `sql_quick_stats` (session_count, message_count, memory_entries, graph_entities, graph_edges, procedure_count, token_usage).",
    };
  },
};

export default sqlQuerySkill;
