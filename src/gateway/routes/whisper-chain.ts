import { Router } from "express";
import { z } from "zod";
import { getWhisperChain, getSessionWhisper, recordWhisper } from "../../agents/whisper-chain.js";
import { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";

const RecordWhisperBody = z.object({
  rootSessionId: z.string().min(1),
  sessionId: z.string().min(1),
  whisper: z.string().min(1),
  agentId: z.string().min(1),
  parentSessionId: z.string().optional(),
  depth: z.number().int().min(0).optional(),
});

export function createWhisperChainRouter(): Router {
  const router = Router();

  router.get("/:rootSessionId", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const chain = await getWhisperChain(req.params["rootSessionId"]!);
    res.json(chain);
  });

  router.get("/session/:sessionId/whisper", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const whisper = await getSessionWhisper(req.params["sessionId"]!);
    res.json({ whisper });
  });

  router.post("/", async (req, res) => {
    const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
    if (!workspaceId) return res.status(400).json({ error: "workspace required" });

    const parsed = RecordWhisperBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { rootSessionId, sessionId, whisper, agentId, parentSessionId, depth } = parsed.data;
    await recordWhisper(rootSessionId, sessionId, whisper, agentId, parentSessionId, depth ?? 0);
    res.json({ ok: true });
  });

  return router;
}
