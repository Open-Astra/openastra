import { Router } from "express";
import { z } from "zod";
import {
  recordOp,
  mergeRemoteOps,
  getState,
  getOpsForMemory,
} from "../../memory/crdt-merge.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";

const RecordOpBody = z.object({
  memoryId: z.string(),
  memoryTable: z.string(),
  opType: z.enum(["add", "remove", "update"]),
  value: z.unknown(),
  fieldPath: z.string().optional(),
  originNode: z.string().optional(),
});

const MergeBody = z.object({
  ops: z.array(z.object({
    memoryId: z.string(),
    memoryTable: z.string(),
    opType: z.enum(["add", "remove", "update"]),
    fieldPath: z.string().optional(),
    value: z.unknown(),
    vectorClock: z.record(z.string(), z.number()),
    originWorkspace: z.string(),
    originNode: z.string().optional(),
    lamportTs: z.number().int(),
  })),
});

export function createMemoryCrdtRouter(): Router {
  const router = Router();

  // POST /ops — record a local CRDT operation
  router.post("/ops", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = RecordOpBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { memoryId, memoryTable, opType, value, fieldPath, originNode } = parsed.data;
      const op = await recordOp(workspaceId, memoryId, memoryTable, opType, value, workspaceId, {
        fieldPath,
        originNode,
      });
      return res.status(201).json(op);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /merge — merge remote operations into local state
  router.post("/merge", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = MergeBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const result = await mergeRemoteOps(workspaceId, parsed.data.ops);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /state/:table/:memoryId — get resolved CRDT state
  router.get("/state/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const state = await getState(workspaceId, memoryId!, table!);
      return res.json(state);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /ops/:table/:memoryId — get op history for a memory entry
  router.get("/ops/:table/:memoryId", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { table, memoryId } = req.params;
      const since = req.query["since"] ? Number(req.query["since"]) : undefined;
      const ops = await getOpsForMemory(workspaceId, memoryId!, table!, since);
      return res.json(ops);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
