import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { requireRole } from "../middleware/rbac.js";
import { getPool } from "../../config/postgres.js";
import { getEventBus } from "../../events/index.js";

const AuditQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  event: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

interface AuditRow {
  id: string;
  event: string;
  uid: string;
  user_id: string;
  agent_id: string;
  action: string;
  session_id: string | null;
  details: unknown;
  metadata: unknown;
  timestamp: string;
}

export function createAuditExportRouter(): Router {
  const router = Router();

  // All audit routes require owner role
  router.use(requireRole("owner"));

  // GET / — paginated audit log
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { from, to, event, limit, offset } = parsed.data;

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (from) {
        conditions.push(`timestamp >= $${paramIdx++}`);
        params.push(new Date(from).getTime());
      }
      if (to) {
        conditions.push(`timestamp <= $${paramIdx++}`);
        params.push(new Date(to).getTime());
      }
      if (event) {
        conditions.push(`event = $${paramIdx++}`);
        params.push(event);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      params.push(limit, offset);
      const rows = await getPool().query<AuditRow>(
        `SELECT id, event, uid, user_id, agent_id, action, session_id, details, metadata, timestamp
         FROM audit_log
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        params,
      );

      res.json({ entries: rows.rows, limit, offset });
    } catch (err) {
      console.error("[audit-export] GET:", err);
      res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });

  // GET /export.csv — CSV download
  router.get("/export.csv", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const { from, to, event, limit, offset } = parsed.data;

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (from) {
        conditions.push(`timestamp >= $${paramIdx++}`);
        params.push(new Date(from).getTime());
      }
      if (to) {
        conditions.push(`timestamp <= $${paramIdx++}`);
        params.push(new Date(to).getTime());
      }
      if (event) {
        conditions.push(`event = $${paramIdx++}`);
        params.push(event);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      params.push(limit, offset);
      const rows = await getPool().query<AuditRow>(
        `SELECT id, event, uid, agent_id, action, session_id, timestamp
         FROM audit_log
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        params,
      );

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="audit-${Date.now()}.csv"`);

      const header = "id,event,uid,agent_id,action,session_id,timestamp\n";
      const csvRows = rows.rows.map((r) =>
        [r.id, r.event, r.uid, r.agent_id, r.action, r.session_id ?? "", r.timestamp]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      );

      res.send(header + csvRows.join("\n"));
    } catch (err) {
      console.error("[audit-export] CSV:", err);
      res.status(500).json({ error: "Failed to export audit log" });
    }
  });

  // POST /stream — SSE stream of live audit events
  router.post("/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const bus = getEventBus();

    const sendAuditEvent = (eventName: string) => (payload: unknown) => {
      res.write(`data: ${JSON.stringify({ event: eventName, payload, timestamp: Date.now() })}\n\n`);
    };

    // Subscribe to all audit-relevant events
    const auditEvents = [
      "tool.executed",
      "memory.written",
      "agent.spawn.started",
      "inference.request",
      "security.token_replay",
      "security.token_revoked",
    ] as const;

    const handlers = auditEvents.map((ev) => {
      const handler = sendAuditEvent(ev);
      bus.on(ev, handler as Parameters<typeof bus.on<typeof ev>>[1]);
      return { ev, handler };
    });

    req.on("close", () => {
      for (const { ev, handler } of handlers) {
        bus.off(ev, handler as Parameters<typeof bus.off<typeof ev>>[1]);
      }
      res.end();
    });
  });

  return router;
}
