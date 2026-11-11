import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  shareMemory,
  getSharedMemories,
  getMemoriesSharedBy,
  revokeSharedMemory,
} from "../../memory/cross-agent.js";
import { authorizeAgentRun } from "../agent-access.js";

const ShareMemoryBody = z.object({
  sourceAgentId: z.string().min(1).max(128),
  targetAgentId: z.string().min(1).max(128),
  memoryType: z.string().min(1).max(64),
  memoryId: z.string().min(1).max(128),
  expiresAt: z.string().datetime().optional(),
});

/** Workspace named by the caller, if any. Membership is verified by authorizeAgentRun. */
function workspaceHeader(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers["x-workspace-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v ? v : null;
}

export function createSharedMemoriesRouter(): Router {
  const router = Router();

  // GET /shared-memories — list memories shared with/by a user's agents
  router.get("/shared-memories", async (req, res) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const agentId = req.query["agentId"] as string | undefined;
    const direction = (req.query["direction"] as string) ?? "received";

    if (!agentId) {
      res.status(400).json({ error: "agentId query parameter required" });
      return;
    }

    try {
      // The caller must be able to use this agent at all…
      const access = await authorizeAgentRun(uid, agentId, workspaceHeader(req), { enforceBudget: false });
      if (!access.ok) {
        res.status(access.status).json({ error: access.message });
        return;
      }

      const all =
        direction === "shared"
          ? await getMemoriesSharedBy(agentId)
          : await getSharedMemories(agentId);

      // …and only sees shares they created. Agents (especially global
      // ones) are used by many users; share rows are per-user data.
      const memories = all.filter((m) => m.sharedBy === uid);

      res.json({ memories, uid });
    } catch (err) {
      console.error("[shared-memories] GET:", err);
      res.status(500).json({ error: "Failed to list shared memories" });
    }
  });

  // POST /shared-memories — share a memory
  router.post("/shared-memories", async (req, res) => {
    const parsed = ShareMemoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;

    try {
      // Both ends of the share must be agents the caller may use
      for (const agentId of [parsed.data.sourceAgentId, parsed.data.targetAgentId]) {
        const access = await authorizeAgentRun(uid, agentId, workspaceHeader(req), { enforceBudget: false });
        if (!access.ok) {
          res.status(access.status).json({ error: access.message });
          return;
        }
      }

      const id = await shareMemory(
        parsed.data.sourceAgentId,
        parsed.data.targetAgentId,
        parsed.data.memoryType,
        parsed.data.memoryId,
        uid,
        parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
      );

      res.status(201).json({ id, shared: true });
    } catch (err) {
      console.error("[shared-memories] POST:", err);
      res.status(500).json({ error: "Failed to share memory" });
    }
  });

  // DELETE /shared-memories/:id — revoke sharing
  router.delete("/shared-memories/:id", async (req, res) => {
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const { id } = req.params;

    try {
      const revoked = await revokeSharedMemory(id, uid);
      if (!revoked) {
        res.status(404).json({ error: "Shared memory not found or not authorized" });
        return;
      }
      res.json({ revoked: true });
    } catch (err) {
      console.error("[shared-memories] DELETE:", err);
      res.status(500).json({ error: "Failed to revoke shared memory" });
    }
  });

  return router;
}
