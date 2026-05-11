import { Router } from "express";
import { z } from "zod";
import {
  createDebugSession,
  getDebugSession,
  listDebugSessions,
  deleteDebugSession,
  step,
  continueExecution,
  setBreakpoints,
  captureSnapshot,
  getSnapshots,
  getSnapshot,
} from "../../agents/debugger.js";
import type { Breakpoint, DebugPhase } from "../../agents/debugger.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const BreakpointSchema = z.object({
  type: z.enum(["tool", "turn", "phase", "error"]),
  name: z.string().optional(),
  number: z.number().int().optional(),
  phase: z.enum(["pre_inference", "post_inference", "pre_tool", "post_tool", "post_turn"]).optional(),
});

const CreateBody = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  breakpoints: z.array(BreakpointSchema).optional(),
  autoCapture: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
});

const SnapshotBody = z.object({
  turn: z.number().int(),
  phase: z.enum(["pre_inference", "post_inference", "pre_tool", "post_tool", "post_turn"]),
  systemPrompt: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
  toolSchemas: z.array(z.unknown()).optional(),
  memoryContext: z.record(z.string(), z.unknown()).optional(),
  inferenceRequest: z.record(z.string(), z.unknown()).optional(),
  inferenceResponse: z.record(z.string(), z.unknown()).optional(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
  tokenUsage: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().int().optional(),
});

export function createAgentDebuggerRouter(): Router {
  const router = Router();

  // GET / — list debug sessions
  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const limit = req.query["limit"] ? Number(req.query["limit"]) : 20;
      const sessions = await listDebugSessions(workspaceId, limit);
      return res.json(sessions);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST / — create a debug session
  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const session = await createDebugSession(
        workspaceId,
        parsed.data.sessionId,
        parsed.data.agentId,
        uid,
        {
          breakpoints: parsed.data.breakpoints as Breakpoint[],
          autoCapture: parsed.data.autoCapture,
          maxTurns: parsed.data.maxTurns,
        },
      );
      return res.status(201).json(session);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id — get a debug session
  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const session = await getDebugSession(req.params.id!, workspaceId);
      if (!session) return res.status(404).json({ error: "not found" });
      return res.json(session);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /:id — delete a debug session
  router.delete("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const deleted = await deleteDebugSession(req.params.id!, workspaceId);
      if (!deleted) return res.status(404).json({ error: "not found" });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /:id/step — step to the next phase
  router.post("/:id/step", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const result = await step(req.params.id!, workspaceId);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /:id/continue — run until next breakpoint
  router.post("/:id/continue", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const result = await continueExecution(req.params.id!, workspaceId);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // PUT /:id/breakpoints — update breakpoints
  router.put("/:id/breakpoints", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = z.array(BreakpointSchema).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const session = await setBreakpoints(req.params.id!, workspaceId, parsed.data as Breakpoint[]);
      return res.json(session);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /:id/snapshots — capture a snapshot
  router.post("/:id/snapshots", async (req, res) => {
    try {
      const parsed = SnapshotBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const snapshot = await captureSnapshot(
        req.params.id!,
        parsed.data.turn,
        parsed.data.phase as DebugPhase,
        parsed.data,
      );
      return res.status(201).json(snapshot);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id/snapshots — list snapshots for a debug session
  router.get("/:id/snapshots", async (req, res) => {
    try {
      const turn = req.query["turn"] ? Number(req.query["turn"]) : undefined;
      const snapshots = await getSnapshots(req.params.id!, turn);
      return res.json(snapshots);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /snapshots/:snapshotId — get a single snapshot
  router.get("/snapshots/:snapshotId", async (req, res) => {
    try {
      const snapshot = await getSnapshot(req.params.snapshotId!);
      if (!snapshot) return res.status(404).json({ error: "not found" });
      return res.json(snapshot);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
