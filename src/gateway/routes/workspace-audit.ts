import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { queryAuditLog, getAuditSummary } from "../../agents/workspace-audit.js";

// ── Workspace Audit Router ──────────────────────────────────────────
// GET /workspace-audit          — query audit log with filters
// GET /workspace-audit/summary  — aggregated audit summary

const AuditQuerySchema = z.object({
  agentId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SummaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function createWorkspaceAuditRouter(): Router {
  const router = Router();

  // GET /workspace-audit — query audit log
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      const uid = (req as AuthenticatedRequest).uid;
      // Fall back to uid-based query if no workspace
      const parsed = AuditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
        return;
      }
      // Use uid as workspace proxy for personal workspace
      const result = await queryAuditLog({
        workspaceId: uid,
        agentId: parsed.data.agentId,
        action: parsed.data.action,
        from: parsed.data.from ? new Date(parsed.data.from) : undefined,
        to: parsed.data.to ? new Date(parsed.data.to) : undefined,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      res.json(result);
      return;
    }

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const result = await queryAuditLog({
      workspaceId,
      agentId: parsed.data.agentId,
      action: parsed.data.action,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json(result);
  });

  // GET /workspace-audit/summary — aggregated audit summary
  router.get("/summary", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      const uid = (req as AuthenticatedRequest).uid;
      const parsed = SummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
        return;
      }
      const summary = await getAuditSummary(
        uid,
        parsed.data.from ? new Date(parsed.data.from) : undefined,
        parsed.data.to ? new Date(parsed.data.to) : undefined,
      );
      res.json(summary);
      return;
    }

    const parsed = SummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    const summary = await getAuditSummary(
      workspaceId,
      parsed.data.from ? new Date(parsed.data.from) : undefined,
      parsed.data.to ? new Date(parsed.data.to) : undefined,
    );

    res.json(summary);
  });

  return router;
}
