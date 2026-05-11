import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  startOnboarding,
  getOnboardingStatus,
  completeStep,
  listOnboardingProcesses,
} from "../../agents/onboarding.js";

const StartBody = z.object({
  agentId: z.string().min(1),
  teamId: z.string().min(1),
});

export function createOnboardingProtocolRouter(): Router {
  const router = Router();

  router.post("/agent-onboarding", async (req, res) => {
    const body = StartBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const process = await startOnboarding(workspaceId, body.data.agentId, body.data.teamId);
      res.status(201).json(process);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-onboarding", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const processes = await listOnboardingProcesses(workspaceId);
      res.json({ processes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-onboarding/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    try {
      const process = await getOnboardingStatus(id);
      if (!process) { res.status(404).json({ error: "Onboarding process not found" }); return; }
      res.json(process);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/agent-onboarding/:id/steps/:step/complete", async (req, res) => {
    const { id, step } = req.params as { id: string; step: string };
    try {
      const process = await completeStep(id, step);
      if (!process) { res.status(404).json({ error: "Onboarding process not found or already completed" }); return; }
      res.json(process);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
