import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  sendAgentMessage,
  getAgentInbox,
  markMessageRead,
  getConversation,
} from "../../agents/agent-messaging.js";

// ── Agent Messages Router ────────────────────────────────────────────
// GET  /agent-messages/inbox/:agentId               — get inbox
// POST /agent-messages                               — send message
// GET  /agent-messages/conversation/:agentId1/:agentId2 — conversation
// POST /agent-messages/:id/read                      — mark read

const SendMessageBody = z.object({
  fromAgentId: z.string(),
  toAgentId: z.string(),
  messageType: z.enum(["text", "request", "response", "notification"]).default("text"),
  content: z.unknown(),
  inReplyTo: z.string().uuid().optional(),
});

const InboxQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const ConversationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function createAgentMessagesRouter(): Router {
  const router = Router();

  // GET /agent-messages/inbox/:agentId
  router.get("/inbox/:agentId", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;
    const agentId = req.params.agentId as string;

    const parsed = InboxQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      const messages = await getAgentInbox(workspaceId, agentId!, parsed.data);
      res.json({ messages });
    } catch (err) {
      console.error("[agent-messages] Inbox error:", err);
      res.status(500).json({ error: "Failed to get inbox" });
    }
  });

  // POST /agent-messages
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;

    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    try {
      const msg = await sendAgentMessage(
        workspaceId,
        parsed.data.fromAgentId,
        parsed.data.toAgentId,
        parsed.data.messageType,
        parsed.data.content,
        parsed.data.inReplyTo,
      );
      res.status(201).json({ message: msg });
    } catch (err) {
      console.error("[agent-messages] Send error:", err);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // GET /agent-messages/conversation/:agentId1/:agentId2
  router.get("/conversation/:agentId1/:agentId2", async (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? (req as AuthenticatedRequest).uid;
    const agentId1 = req.params.agentId1 as string;
    const agentId2 = req.params.agentId2 as string;

    const parsed = ConversationQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.format() });
      return;
    }

    try {
      const messages = await getConversation(workspaceId, agentId1!, agentId2!, parsed.data.limit);
      res.json({ messages });
    } catch (err) {
      console.error("[agent-messages] Conversation error:", err);
      res.status(500).json({ error: "Failed to get conversation" });
    }
  });

  // POST /agent-messages/:id/read
  router.post("/:id/read", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      await markMessageRead(id!);
      res.json({ ok: true });
    } catch (err) {
      console.error("[agent-messages] Mark read error:", err);
      res.status(500).json({ error: "Failed to mark message as read" });
    }
  });

  return router;
}
