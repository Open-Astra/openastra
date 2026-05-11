// Mount: app.use("/memory/snapshots", jwtAuth(), workspaceResolver(), createMemorySnapshotsRouter())

import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { createMemorySnapshot, restoreMemorySnapshot, listSnapshots } from "../../memory/snapshot.js";

const CreateSnapshotBody = z.object({
  uid: z.string().min(1),
  label: z.string().max(255).optional(),
});

const RestoreBody = z.object({
  uid: z.string().min(1),
});

export function createMemorySnapshotsRouter(): Router {
  const router = Router();

  // GET /memory/snapshots?uid=
  router.get("/", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const workspaceId = r.workspace?.workspaceId ?? r.uid;

    const parsed = z.object({ uid: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "uid query parameter is required" });
      return;
    }

    try {
      const snapshots = await listSnapshots(workspaceId, parsed.data.uid);
      res.json({ snapshots });
    } catch (err) {
      console.error("[memory-snapshots] List error:", err);
      res.status(500).json({ error: "Failed to list memory snapshots" });
    }
  });

  // POST /memory/snapshots — create a new snapshot
  router.post("/", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const workspaceId = r.workspace?.workspaceId ?? r.uid;

    const parsed = CreateSnapshotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.format() });
      return;
    }

    const { uid, label } = parsed.data;

    try {
      const snapshotId = await createMemorySnapshot(workspaceId, uid, label);
      res.status(201).json({ snapshotId });
    } catch (err) {
      console.error("[memory-snapshots] Create error:", err);
      res.status(500).json({ error: "Failed to create memory snapshot" });
    }
  });

  // POST /memory/snapshots/:id/restore — restore a snapshot
  router.post("/:id/restore", async (req, res) => {
    const r = req as unknown as AuthenticatedRequest & WorkspaceAwareRequest;
    const workspaceId = r.workspace?.workspaceId ?? r.uid;
    const snapshotId = req.params.id;

    const parsed = RestoreBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "uid is required in request body" });
      return;
    }

    try {
      await restoreMemorySnapshot(snapshotId, workspaceId, parsed.data.uid);
      res.json({ restored: true, snapshotId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("does not belong")) {
        res.status(404).json({ error: msg });
        return;
      }
      console.error("[memory-snapshots] Restore error:", err);
      res.status(500).json({ error: "Failed to restore memory snapshot" });
    }
  });

  return router;
}
