import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  createChannel, subscribe, unsubscribe, broadcast,
  getChannels, getChannel, deleteChannel, getMessages,
} from "../../agents/team-channels.js";

const CreateBody = z.object({ name: z.string(), description: z.string().optional() });
const AgentBody = z.object({ agentId: z.string() });
const MsgBody = z.object({
  agentId: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createTeamChannelsRouter(): Router {
  const router = Router();

  router.post("/team-channels", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const ch = await createChannel(workspaceId, parsed.data.name, parsed.data.description);
    res.status(201).json(ch);
  });

  router.get("/team-channels", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    res.json({ channels: await getChannels(workspaceId) });
  });

  router.get("/team-channels/:id", async (req, res) => {
    const ch = await getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    res.json(ch);
  });

  router.delete("/team-channels/:id", async (req, res) => {
    await deleteChannel(req.params.id);
    res.json({ deleted: true });
  });

  router.post("/team-channels/:id/subscribe", async (req, res) => {
    const parsed = AgentBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await subscribe(req.params.id, parsed.data.agentId);
    res.json({ subscribed: true });
  });

  router.post("/team-channels/:id/unsubscribe", async (req, res) => {
    const parsed = AgentBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await unsubscribe(req.params.id, parsed.data.agentId);
    res.json({ unsubscribed: true });
  });

  router.post("/team-channels/:id/messages", async (req, res) => {
    const parsed = MsgBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const msg = await broadcast(req.params.id, parsed.data.agentId, parsed.data.message, parsed.data.metadata);
    res.status(201).json(msg);
  });

  router.get("/team-channels/:id/messages", async (req, res) => {
    const limit = parseInt(String(req.query["limit"] ?? "50"), 10);
    const since = req.query["since"] ? new Date(String(req.query["since"])) : undefined;
    const msgs = await getMessages(req.params.id, { limit, since });
    res.json({ messages: msgs });
  });

  return router;
}
