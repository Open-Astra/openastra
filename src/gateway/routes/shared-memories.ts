import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  shareMemory,
  getSharedMemories,
  getMemoriesSharedBy,
  revokeSharedMemory,
} from "../../memory/cross-agent.js";

const ShareMemoryBody = z.object({
  sourceAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
  memoryType: z.string().min(1),
  memoryId: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});

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
      const memories =
        direction === "shared"
          ? await getMemoriesSharedBy(agentId)
          : await getSharedMemories(agentId);

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
