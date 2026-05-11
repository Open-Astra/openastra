import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getAgentConfigById, createAgentConfig } from "../../agents/config-store.js";
import type { AgentConfig } from "../../agents/types.js";

const CloneBody = z.object({
  newId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(100).optional(),
});

export function createAgentCloneRouter(): Router {
  const router = Router();

  // POST /agents/:agentId/clone — duplicate an agent config with a new ID
  router.post("/agents/:agentId/clone", async (req, res) => {
    const body = CloneBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }

    const { agentId } = req.params as { agentId: string };
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }
    const uid = (req as unknown as AuthenticatedRequest).uid;

    try {
      const source = await getAgentConfigById(agentId, workspaceId);
      if (!source) {
        res.status(404).json({ error: `Agent ${agentId} not found` });
        return;
      }

      const cloned: AgentConfig = {
        ...source,
        id: body.data.newId,
        displayName: body.data.displayName ?? `${source.displayName} (copy)`,
      };

      await createAgentConfig(cloned, workspaceId, uid);
      res.status(201).json(cloned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate") || msg.includes("already")) {
        res.status(409).json({ error: `Agent ID "${body.data.newId}" already exists` });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
