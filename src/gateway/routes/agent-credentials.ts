// ── Route: Agent Credential Vault ──────────────────────────────────────
import { Router } from "express";
import { z } from "zod";
import {
  setCredential, listCredentialKeys, deleteCredential,
} from "../../agents/credential-vault.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const SetBody = z.object({
  agentId: z.string(),
  key: z.string().min(1).max(128),
  value: z.string().min(1),
});

export function createAgentCredentialsRouter(): Router {
  const router = Router();

  router.get("/:agentId", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const keys = await listCredentialKeys(workspaceId, req.params["agentId"]!);
    res.json({ keys });
  });

  router.put("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const uid = (req as unknown as AuthenticatedRequest).uid;
    const parse = SetBody.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });
    const { agentId, key, value } = parse.data;
    await setCredential(workspaceId, agentId, key, value, uid);
    res.json({ ok: true });
  });

  router.delete("/:agentId/:key", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });
    const deleted = await deleteCredential(workspaceId, req.params["agentId"]!, req.params["key"]!);
    res.json({ deleted });
  });

  return router;
}
