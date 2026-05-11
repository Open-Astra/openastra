import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Cross-Session Search Skill ────────────────────────────────────
// Searches across all session messages (active and archived) for a
// user. Useful for recalling past conversations, decisions, and
// context that may not have been explicitly saved to memory.

const SessionSearchParams = z.object({
  query: z.string().describe("Text to search for across all session messages"),
  role: z.enum(["user", "assistant", "tool", "any"]).optional().describe("Filter by message role (default: any)"),
  limit: z.number().min(1).max(50).optional().describe("Max results (default 10)"),
  daysBack: z.number().min(1).max(365).optional().describe("Only search messages from the last N days (default: all)"),
});

const SessionListParams = z.object({
  status: z.enum(["active", "archived", "compacted", "all"]).optional().describe("Filter by session status (default: all)"),
  limit: z.number().min(1).max(50).optional().describe("Max sessions to return (default 10)"),
});

const SessionMessagesParams = z.object({
  sessionId: z.string().uuid().describe("Session ID to retrieve messages from"),
  limit: z.number().min(1).max(100).optional().describe("Max messages to return (default 50)"),
});

const sessionSearchSkill: SkillDefinition = {
  name: "session_search",
  version: "1.0.0",

  manifest: {
    id: "session_search",
    name: "Session Search",
    description: "Search across all past session messages and browse session history. Finds context from archived conversations.",
    category: "search",
    tools: ["session_search", "session_list", "session_messages"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "session_search",
      description: "Search across all session messages (active and archived) for matching text. Returns matching messages with session context.",
      parameters: SessionSearchParams,

      async execute(params, toolCtx) {
        const pool = getPool();
        const uid = toolCtx.uid;
        const limit = params.limit ?? 10;
        const role = params.role ?? "any";

        const conditions: string[] = ["s.user_id = $1", "m.content ILIKE $2"];
        const values: unknown[] = [uid, `%${params.query}%`];
        let idx = 3;

        if (role !== "any") {
          conditions.push(`m.role = $${idx++}`);
          values.push(role);
        }

        if (params.daysBack) {
          conditions.push(`m.timestamp > $${idx++}`);
          values.push(Date.now() - params.daysBack * 86400000);
        }

        values.push(limit);

        const { rows } = await pool.query<{
          message_id: string;
          session_id: string;
          role: string;
          content: string;
          timestamp: string;
          session_status: string;
          agent_id: string;
          surface: string;
        }>(
          `SELECT
             m.id AS message_id,
             m.session_id,
             m.role,
             m.content,
             m.timestamp,
             s.status AS session_status,
             s.agent_id,
             s.surface
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY m.timestamp DESC
           LIMIT $${idx}`,
          values,
        );

        return {
          query: params.query,
          matchCount: rows.length,
          matches: rows.map((r) => ({
            messageId: r.message_id,
            sessionId: r.session_id,
            role: r.role,
            content: r.content.slice(0, 500),
            timestamp: parseInt(r.timestamp, 10),
            date: new Date(parseInt(r.timestamp, 10)).toISOString().slice(0, 10),
            sessionStatus: r.session_status,
            agentId: r.agent_id,
            surface: r.surface,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "session_list",
      description: "List past sessions for the user, optionally filtered by status. Shows session metadata like message count, agent, and last active time.",
      parameters: SessionListParams,

      async execute(params, toolCtx) {
        const pool = getPool();
        const uid = toolCtx.uid;
        const limit = params.limit ?? 10;
        const status = params.status ?? "all";

        const conditions: string[] = ["user_id = $1"];
        const values: unknown[] = [uid];
        let idx = 2;

        if (status !== "all") {
          conditions.push(`status = $${idx++}`);
          values.push(status);
        }

        values.push(limit);

        const { rows } = await pool.query<{
          id: string;
          agent_id: string;
          surface: string;
          surface_id: string;
          status: string;
          message_count: number;
          token_count: number;
          created_at: string;
          last_active_at: string;
          compaction_summary: string | null;
        }>(
          `SELECT id, agent_id, surface, surface_id, status,
                  message_count, token_count, created_at, last_active_at,
                  compaction_summary
           FROM sessions
           WHERE ${conditions.join(" AND ")}
           ORDER BY last_active_at DESC
           LIMIT $${idx}`,
          values,
        );

        return {
          sessionCount: rows.length,
          sessions: rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            surface: r.surface,
            surfaceId: r.surface_id,
            status: r.status,
            messageCount: r.message_count,
            tokenCount: r.token_count,
            createdAt: new Date(r.created_at).toISOString(),
            lastActiveAt: new Date(r.last_active_at).toISOString(),
            summary: r.compaction_summary?.slice(0, 200) ?? null,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "session_messages",
      description: "Retrieve messages from a specific session. Useful for reviewing a past conversation in detail.",
      parameters: SessionMessagesParams,

      async execute(params, toolCtx) {
        const pool = getPool();
        const uid = toolCtx.uid;

        // Verify session belongs to user
        const { rows: sessionRows } = await pool.query<{ id: string }>(
          "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
          [params.sessionId, uid],
        );

        if (sessionRows.length === 0) {
          return { error: "Session not found or does not belong to you." };
        }

        const limit = params.limit ?? 50;
        const { rows } = await pool.query<{
          id: string;
          role: string;
          content: string;
          tool_calls: unknown;
          timestamp: string;
        }>(
          `SELECT id, role, content, tool_calls, timestamp
           FROM messages
           WHERE session_id = $1
           ORDER BY timestamp ASC
           LIMIT $2`,
          [params.sessionId, limit],
        );

        return {
          sessionId: params.sessionId,
          messageCount: rows.length,
          messages: rows.map((r) => ({
            id: r.id,
            role: r.role,
            content: r.content.slice(0, 1000),
            hasToolCalls: r.tool_calls != null,
            timestamp: parseInt(r.timestamp, 10),
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "session_search",
      instructions:
        "You can search past conversations with `session_search` (full-text across all sessions), browse sessions with `session_list`, and review specific conversations with `session_messages`.",
    };
  },
};

export default sessionSearchSkill;
