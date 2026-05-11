import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getPool } from "../../config/postgres.js";
import { getAgentConfig } from "../../config/agents.js";

// ── Session History REST Router ───────────────────────────────────
// Provides HTTP endpoints for browsing and searching session history.

export function createSessionRouter(): Router {
  const router = Router();

  // GET /sessions — list sessions for the authenticated user
  router.get("/", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const status = (req.query.status as string) || "all";
    const limit = Math.min(parseInt(req.query.limit as string || "20", 10), 50);
    const offset = parseInt(req.query.offset as string || "0", 10);

    try {
      const pool = getPool();
      const conditions: string[] = ["user_id = $1"];
      const values: unknown[] = [uid];
      let idx = 2;

      if (status !== "all") {
        conditions.push(`status = $${idx++}`);
        values.push(status);
      }

      const limitIdx = idx++;
      const offsetIdx = idx++;
      values.push(limit, offset);

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
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        values,
      );

      // Get total count — reuse the same filter values (minus limit/offset)
      const countValues = values.slice(0, -2);
      const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM sessions WHERE ${conditions.join(" AND ")}`,
        countValues,
      );

      res.json({
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
        total: parseInt(countRows[0]?.count ?? "0", 10),
        limit,
        offset,
      });
    } catch (err) {
      console.error("[sessions] List error:", err);
      res.status(500).json({ error: "Failed to list sessions" });
    }
  });

  // GET /sessions/:id — get session details with messages
  router.get("/:id", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const sessionId = req.params.id;
    const messageLimit = Math.min(parseInt(req.query.limit as string || "50", 10), 200);

    try {
      const pool = getPool();

      // Verify session belongs to user
      const { rows: sessionRows } = await pool.query<{
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
        "SELECT * FROM sessions WHERE id = $1 AND user_id = $2",
        [sessionId, uid],
      );

      if (sessionRows.length === 0) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const session = sessionRows[0]!;

      // Load messages
      const { rows: messages } = await pool.query<{
        id: string;
        role: string;
        content: string;
        tool_calls: unknown;
        tool_call_id: string | null;
        timestamp: string;
      }>(
        `SELECT id, role, content, tool_calls, tool_call_id, timestamp
         FROM messages WHERE session_id = $1
         ORDER BY timestamp ASC LIMIT $2`,
        [sessionId, messageLimit],
      );

      res.json({
        session: {
          id: session.id,
          agentId: session.agent_id,
          surface: session.surface,
          surfaceId: session.surface_id,
          status: session.status,
          messageCount: session.message_count,
          tokenCount: session.token_count,
          createdAt: new Date(session.created_at).toISOString(),
          lastActiveAt: new Date(session.last_active_at).toISOString(),
          summary: session.compaction_summary,
        },
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.tool_calls,
          toolCallId: m.tool_call_id,
          timestamp: parseInt(m.timestamp, 10),
        })),
      });
    } catch (err) {
      console.error("[sessions] Get error:", err);
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  // GET /sessions/search — search across session messages
  router.get("/search/messages", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const query = req.query.q as string;
    const limit = Math.min(parseInt(req.query.limit as string || "20", 10), 50);

    if (!query) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    try {
      const pool = getPool();

      const { rows } = await pool.query<{
        message_id: string;
        session_id: string;
        role: string;
        content: string;
        timestamp: string;
        agent_id: string;
        surface: string;
      }>(
        `SELECT m.id AS message_id, m.session_id, m.role, m.content,
                m.timestamp, s.agent_id, s.surface
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = $1 AND m.content ILIKE $2
         ORDER BY m.timestamp DESC
         LIMIT $3`,
        [uid, `%${query}%`, limit],
      );

      res.json({
        query,
        matches: rows.map((r) => ({
          messageId: r.message_id,
          sessionId: r.session_id,
          role: r.role,
          content: r.content.slice(0, 500),
          timestamp: parseInt(r.timestamp, 10),
          agentId: r.agent_id,
          surface: r.surface,
        })),
      });
    } catch (err) {
      console.error("[sessions] Search error:", err);
      res.status(500).json({ error: "Failed to search sessions" });
    }
  });

  // POST /sessions/:id/handoff — transfer session to a different agent (rec 20)
  // Inserts a system handoff marker and switches the session's agent_id
  // so all future turns are handled by the target agent.
  router.post("/:id/handoff", async (req, res) => {
    const { uid } = req as unknown as AuthenticatedRequest;
    const sessionId = req.params.id;

    const parsed = z.object({ targetAgent: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "targetAgent is required" });
      return;
    }

    const { targetAgent } = parsed.data;

    try {
      const pool = getPool();

      // Verify session belongs to user
      const { rows } = await pool.query<{ id: string; agent_id: string }>(
        "SELECT id, agent_id FROM sessions WHERE id = $1 AND user_id = $2 AND status = 'active'",
        [sessionId, uid],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Active session not found" });
        return;
      }

      const previousAgent = rows[0]!.agent_id;

      // Verify target agent exists
      let targetConfig;
      try {
        targetConfig = getAgentConfig(targetAgent);
      } catch {
        res.status(404).json({ error: `Agent "${targetAgent}" not found` });
        return;
      }

      // Insert system handoff marker into messages
      const markerId = randomUUID();
      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, token_estimate, timestamp)
         VALUES ($1, $2, 'system', $3, 10, $4)`,
        [
          markerId,
          sessionId,
          `[Handoff] Conversation transferred from agent "${previousAgent}" to "${targetAgent}" (${targetConfig.displayName}).`,
          Date.now(),
        ],
      );

      // Switch session to new agent
      await pool.query(
        "UPDATE sessions SET agent_id = $2, last_active_at = NOW() WHERE id = $1",
        [sessionId, targetAgent],
      );

      res.json({
        sessionId,
        previousAgent,
        currentAgent: targetAgent,
        markerMessageId: markerId,
      });
    } catch (err) {
      console.error("[sessions] Handoff error:", err);
      res.status(500).json({ error: "Failed to hand off session" });
    }
  });

  return router;
}
