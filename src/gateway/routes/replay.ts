import { Router } from "express";
import { z } from "zod";
import {
  startRecording,
  completeRecording,
  getRecording,
  listRecordings,
  getRecordingEvents,
  startReplay,
  getReplayRun,
  listReplayRuns,
} from "../../agents/deterministic-replay.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const StartRecordingBody = z.object({
  sessionId: z.string(),
  agentId: z.string(),
});

export function createReplayRouter(): Router {
  const router = Router();

  // GET / — list recordings for workspace
  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const limit = req.query["limit"] ? Number(req.query["limit"]) : 50;
      const recordings = await listRecordings(workspaceId, limit);
      return res.json(recordings);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST / — start a new recording
  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const parsed = StartRecordingBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const recording = await startRecording(workspaceId, parsed.data.sessionId, parsed.data.agentId, uid);
      return res.status(201).json(recording);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id — get a recording
  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const recording = await getRecording(req.params.id!, workspaceId);
      if (!recording) return res.status(404).json({ error: "not found" });
      return res.json(recording);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /:id/complete — complete a recording
  router.post("/:id/complete", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const recording = await getRecording(req.params.id!, workspaceId);
      if (!recording) return res.status(404).json({ error: "not found" });
      await completeRecording(req.params.id!);
      return res.json({ completed: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id/events — get recorded events
  router.get("/:id/events", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const recording = await getRecording(req.params.id!, workspaceId);
      if (!recording) return res.status(404).json({ error: "not found" });
      const events = await getRecordingEvents(req.params.id!);
      return res.json(events);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /:id/replay — start a replay of a recording
  router.post("/:id/replay", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const recording = await getRecording(req.params.id!, workspaceId);
      if (!recording) return res.status(404).json({ error: "not found" });
      if (recording.status !== "completed") {
        return res.status(400).json({ error: "Can only replay completed recordings" });
      }

      const run = await startReplay(req.params.id!, workspaceId, uid);
      return res.status(201).json(run);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id/replays — list replay runs for a recording
  router.get("/:id/replays", async (req, res) => {
    try {
      const runs = await listReplayRuns(req.params.id!);
      return res.json(runs);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /runs/:runId — get a specific replay run
  router.get("/runs/:runId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const run = await getReplayRun(req.params.runId!, workspaceId);
      if (!run) return res.status(404).json({ error: "not found" });
      return res.json(run);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
