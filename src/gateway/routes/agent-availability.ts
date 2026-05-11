import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  setSchedule,
  addMaintenanceWindow,
  getAgentAvailability,
  getAvailableAgents,
  getMaintenanceWindows,
  cancelMaintenanceWindow,
} from "../../agents/availability.js";

const DaySlot = z.object({ start: z.string(), end: z.string() });
const ScheduleBody = z.object({
  mon: DaySlot.optional(),
  tue: DaySlot.optional(),
  wed: DaySlot.optional(),
  thu: DaySlot.optional(),
  fri: DaySlot.optional(),
  sat: DaySlot.optional(),
  sun: DaySlot.optional(),
});

const MaintenanceBody = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string().min(1),
});

export function createAgentAvailabilityRouter(): Router {
  const router = Router();

  router.put("/agent-availability/:agentId/schedule", async (req, res) => {
    const body = ScheduleBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      await setSchedule(workspaceId, agentId, body.data);
      res.json({ updated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-availability/:agentId", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const availability = await getAgentAvailability(workspaceId, agentId);
      res.json(availability);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-availability", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const agents = await getAvailableAgents(workspaceId);
      res.json({ availableAgents: agents });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post("/agent-availability/:agentId/maintenance", async (req, res) => {
    const body = MaintenanceBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const window = await addMaintenanceWindow(workspaceId, agentId, {
        from: new Date(body.data.from),
        to: new Date(body.data.to),
        reason: body.data.reason,
      });
      res.status(201).json(window);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get("/agent-availability/:agentId/maintenance", async (req, res) => {
    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const windows = await getMaintenanceWindows(workspaceId, agentId);
      res.json({ windows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete("/agent-availability/maintenance/:id", async (req, res) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    try {
      const ok = await cancelMaintenanceWindow(id, workspaceId);
      if (!ok) { res.status(404).json({ error: "Maintenance window not found" }); return; }
      res.json({ cancelled: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
