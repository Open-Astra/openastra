import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  setSLA,
  getSLA,
  getWorkspaceSLAs,
  deleteSLA,
  checkSLAStatus,
  getBreachingAgents,
} from "../../agents/sla.js";

// ── SLA Router ───────────────────────────────────────────────────────

const SetSLABody = z.object({
  agentId: z.string().min(1).max(128),
  maxLatencyMs: z.number().int().positive().optional().default(30000),
  minConfidence: z.number().min(0).max(1).optional().default(0.7),
  maxErrorRate: z.number().min(0).max(1).optional().default(0.1),
  backupAgentId: z.string().optional(),
  alertOnBreach: z.boolean().optional().default(true),
});

export function createSlaRouter(): Router {
  const router = Router();

  // GET /sla — list workspace SLAs
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const slas = await getWorkspaceSLAs(workspaceId);
    res.json(slas);
  });

  // POST /sla — set/update SLA
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = SetSLABody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    await setSLA({
      workspaceId,
      agentId: parsed.data.agentId,
      maxLatencyMs: parsed.data.maxLatencyMs,
      minConfidence: parsed.data.minConfidence,
      maxErrorRate: parsed.data.maxErrorRate,
      backupAgentId: parsed.data.backupAgentId,
      alertOnBreach: parsed.data.alertOnBreach,
    });

    const sla = await getSLA(workspaceId, parsed.data.agentId);
    res.status(201).json(sla);
  });

  // DELETE /sla/:agentId — delete SLA
  router.delete("/:agentId", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    await deleteSLA(workspaceId, String(req.params.agentId));
    res.status(204).end();
  });

  // GET /sla/:agentId/status — get current SLA status
  router.get("/:agentId/status", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const windowMinutes = req.query.window ? parseInt(req.query.window as string, 10) : undefined;
    const status = await checkSLAStatus(workspaceId, String(req.params.agentId), windowMinutes);
    res.json(status);
  });

  // GET /sla/breaches — get all breaching agents
  router.get("/breaches", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const breaches = await getBreachingAgents(workspaceId);
    res.json(breaches);
  });

  return router;
}
