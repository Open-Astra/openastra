// ── Channel Abstraction ─────────────────────────────────────────────
// Shared interface and utilities for all messaging channels (Telegram,
// iMessage, etc.). Unlike OpenClaw's flat Markdown memory, our channels
// leverage PostgreSQL sessions, Typesense semantic search, and token
// budget tracking for persistent, searchable, cost-aware conversations.

import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import type { AgentResponse } from "../agents/loop.js";
import { runAgentLoop } from "../agents/loop.js";
import type { MessageInput, MessagePart } from "../agents/message-input.js";
import { resetSession } from "../sessions/store.js";
import { trackTokenUsage } from "../billing/tracker.js";
import { getChannelAgentMapping, getDefaultAgentId } from "./router.js";
import { getPool } from "../config/postgres.js";
import { info as logInfo, error as logError, dim as logDim } from "../utils/logger.js";

// ── Channel Types ──────────────────────────────────────────────────

export type ChannelType = "telegram" | "imessage" | "webchat" | "whatsapp" | "signal" | "discord" | "slack" | "google-chat" | "teams" | "line" | "viber" | "twitter" | "email" | "github" | "linear";

export interface IncomingMessage {
  /** Channel this message arrived on */
  channel: ChannelType;
  /** Platform-specific chat/conversation ID */
  chatId: string;
  /** Platform-specific sender ID */
  senderId: string;
  /** Sender display name */
  senderName: string;
  /** Message text (may be undefined for media-only) */
  text?: string;
  /** Whether this is a group chat */
  isGroup: boolean;
  /** Platform-specific message ID for reply threading */
  messageId?: string;
  /** Attachments (images, files, etc.) */
  attachments?: Attachment[];
}

export interface Attachment {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  mimeType?: string;
  filename?: string;
  /** Base64-encoded data (for platforms that don't provide URLs) */
  data?: string;
}

export interface OutgoingMessage {
  text: string;
  /** Optional reply-to message ID */
  replyTo?: string;
}

export interface ChannelAdapter {
  /** Channel identifier */
  readonly channelType: ChannelType;
  /** Send a text message to a chat */
  sendMessage(chatId: string, message: OutgoingMessage): Promise<void>;
  /** Send a typing/activity indicator */
  sendTypingIndicator(chatId: string): Promise<void>;
  /** Start the channel (connect, begin polling, etc.) */
  start(): Promise<void>;
  /** Stop the channel gracefully */
  stop(): Promise<void>;
}

// ── Slash Commands ─────────────────────────────────────────────────
// OpenClaw-style commands available in all channels. Our /memory and
// /usage commands go beyond OpenClaw by exposing semantic search and
// real cost tracking.

export interface CommandResult {
  handled: boolean;
  response?: string;
}

const HELP_TEXT = `*Available Commands*

/reset — Clear conversation history
/agent — Show current agent info
/agents — List available agents
/switch <id> — Switch to a different agent
/memory <query> — Search your memory (semantic + keyword)
/usage — Show token usage & costs this month
/help — Show this help message`;

export async function handleChannelCommand(
  command: string,
  msg: IncomingMessage,
  agentConfig: AgentConfig,
  _resolveClient: ClientResolver,
): Promise<CommandResult> {
  const uid = channelUid(msg);
  const parts = command.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();

  switch (cmd) {
    case "/start":
      return {
        handled: true,
        response: `Welcome to Astra! I'm *${agentConfig.displayName}* powered by ${agentConfig.model.provider}/${agentConfig.model.modelId}.\n\nI remember our conversations, can search my memory semantically, and track usage costs.\n\nType /help for commands, or just start chatting.`,
      };

    case "/help":
      return { handled: true, response: HELP_TEXT };

    case "/reset": {
      const sessionKey = channelSessionKey(msg);
      await resetSession(sessionKey, agentConfig);
      return { handled: true, response: "Session reset. Starting fresh." };
    }

    case "/agent":
      return {
        handled: true,
        response:
          `*${agentConfig.displayName}*\n` +
          `Provider: ${agentConfig.model.provider}\n` +
          `Model: ${agentConfig.model.modelId}\n` +
          `Context: ${agentConfig.model.maxContextTokens.toLocaleString()} tokens\n` +
          `Skills: ${agentConfig.skills.length > 0 ? agentConfig.skills.join(", ") : "none"}`,
      };

    case "/agents": {
      const { getAllAgentConfigs } = await import("../config/agents.js");
      const configs = getAllAgentConfigs();
      if (configs.size === 0) return { handled: true, response: "No agents configured." };
      const lines = ["*Available Agents*\n"];
      for (const [id, cfg] of configs) {
        const current = id === agentConfig.id ? " (current)" : "";
        lines.push(`• \`${id}\` — ${cfg.displayName} (${cfg.model.provider})${current}`);
      }
      lines.push("\nUse /switch <id> to change agents.");
      return { handled: true, response: lines.join("\n") };
    }

    case "/switch": {
      const targetId = parts[1];
      if (!targetId) return { handled: true, response: "Usage: /switch <agent-id>" };
      try {
        const { getAgentConfig } = await import("../config/agents.js");
        const target = getAgentConfig(targetId);
        // Persist the routing change
        const { setChannelAgentMapping } = await import("./router.js");
        await setChannelAgentMapping(msg.channel, msg.chatId, targetId);
        return {
          handled: true,
          response: `Switched to *${target.displayName}* (${target.model.provider}/${target.model.modelId}).`,
        };
      } catch {
        return { handled: true, response: `Agent "${targetId}" not found.` };
      }
    }

    case "/memory": {
      const query = parts.slice(1).join(" ");
      if (!query) return { handled: true, response: "Usage: /memory <search query>" };
      try {
        const { searchMemory } = await import("../memory/search.js");
        const results = await searchMemory(uid, query, 5);
        if (results.length === 0) return { handled: true, response: "No memories found." };
        const lines = [`*Memory Search: "${query}"*\n`];
        for (const r of results) {
          const score = (r.score * 100).toFixed(0);
          const dateTag = r.date ? ` [${r.date}]` : "";
          lines.push(`• (${score}%)${dateTag} ${r.content.slice(0, 200)}`);
        }
        return { handled: true, response: lines.join("\n") };
      } catch {
        return { handled: true, response: "Memory search unavailable (Typesense not configured)." };
      }
    }

    case "/usage": {
      try {
        const { getUsageSummary } = await import("../billing/tracker.js");
        const summary = await getUsageSummary(uid);
        const lines = [
          "*Token Usage (this month)*\n",
          `Prompt: ${summary.totalPromptTokens.toLocaleString()}`,
          `Completion: ${summary.totalCompletionTokens.toLocaleString()}`,
          `Total: ${summary.totalTokens.toLocaleString()}`,
          `Requests: ${summary.requestCount}`,
        ];
        if (Object.keys(summary.byAgent).length > 0) {
          lines.push("\n*By Agent:*");
          for (const [agentId, bucket] of Object.entries(summary.byAgent)) {
            lines.push(`• ${agentId}: ${bucket.total.toLocaleString()} tokens (${bucket.count} requests)`);
          }
        }
        return { handled: true, response: lines.join("\n") };
      } catch {
        return { handled: true, response: "Usage tracking unavailable." };
      }
    }

    default:
      return { handled: false };
  }
}

// ── Core Message Handler ───────────────────────────────────────────
// Shared message processing for all channels. This is the OpenClaw
// equivalent of their gateway loop, but backed by Postgres + Typesense.

export type ClientResolver = (config: AgentConfig) => InferenceClient;

export async function handleIncomingMessage(
  msg: IncomingMessage,
  adapter: ChannelAdapter,
  resolveClient: ClientResolver,
): Promise<void> {
  if (!msg.text?.trim()) return;

  const text = msg.text.trim();
  const uid = channelUid(msg);

  // Resolve which agent handles this chat
  const agentId = await resolveAgentForChat(msg);
  let agentConfig: AgentConfig;
  try {
    const { getAgentConfig } = await import("../config/agents.js");
    agentConfig = getAgentConfig(agentId);
  } catch {
    // Fallback: try the first available agent
    const { getAllAgentConfigs } = await import("../config/agents.js");
    const all = getAllAgentConfigs();
    if (all.size === 0) {
      await adapter.sendMessage(msg.chatId, { text: "No agents configured. Create one via the API first." });
      return;
    }
    agentConfig = all.values().next().value!;
  }

  // Handle slash commands
  if (text.startsWith("/")) {
    const result = await handleChannelCommand(text, msg, agentConfig, resolveClient);
    if (result.handled) {
      if (result.response) {
        await adapter.sendMessage(msg.chatId, { text: result.response, replyTo: msg.messageId });
      }
      return;
    }
  }

  // Send typing indicator
  await adapter.sendTypingIndicator(msg.chatId).catch(() => {});

  logInfo(msg.channel, `Message from ${msg.senderName} (${uid}) in ${msg.chatId}`);

  try {
    // Prepare attachment context — build multimodal input for image attachments
    let messageInput: string | MessageInput = text;
    if (msg.attachments?.length) {
      const imageAttachments = msg.attachments.filter((a) => a.type === "image" && a.url);
      if (imageAttachments.length > 0) {
        const parts: MessagePart[] = [{ type: "text", text }];
        for (const img of imageAttachments) {
          parts.push({ type: "image_url", url: img.url! });
        }
        messageInput = parts;
      } else {
        // Non-image attachments: text description fallback
        const attachDesc = msg.attachments
          .map((a) => `[${a.type}: ${a.filename ?? a.mimeType ?? "unknown"}]`)
          .join(" ");
        messageInput = `${text}\n\n(Attachments: ${attachDesc})`;
      }
    }

    // Ensure user row exists (sessions FK requires it)
    await ensureChannelUser(uid, msg.senderName);

    const inferenceClient = resolveClient(agentConfig);
    const sessionKey = channelSessionKey(msg);

    const response: AgentResponse = await runAgentLoop(
      uid,
      messageInput,
      agentConfig,
      inferenceClient,
      sessionKey,
    );

    // Track token usage
    trackTokenUsage(uid, agentConfig.id, response.tokenUsage, response.sessionId).catch(() => {});

    // Send response (split long messages)
    const responseText = response.content || "I processed your request but have nothing to say.";
    await adapter.sendMessage(msg.chatId, { text: responseText });

    // Log tool usage for observability
    if (response.toolResults.length > 0) {
      const toolNames = response.toolResults.map((t) => t.name).join(", ");
      logDim(msg.channel, `Tools: ${toolNames}`);
    }

    logInfo(msg.channel, `Response → ${uid}: ${response.tokenUsage.total} tokens, ${response.toolResults.length} tools`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(msg.channel, `Error handling message from ${uid}:`, errMsg);
    await adapter.sendMessage(msg.chatId, {
      text: "Something went wrong. Please try again.",
      replyTo: msg.messageId,
    }).catch(() => {});
  }
}

// ── Channel → UID Mapping ─────────────────────────────────────────
// Maps channel sender IDs to internal UIDs so that channel users share
// memory/sessions with their CLI identity. Populated from astra.yml
// channels.*.userMap at startup.

const _channelUserMap = new Map<string, string>();

export function setChannelUserMap(channel: string, map: Record<string, string>): void {
  for (const [senderId, uid] of Object.entries(map)) {
    _channelUserMap.set(`${channel}:${senderId}`, uid);
    logInfo(channel, `User map: ${senderId} → ${uid}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Generate a stable uid from channel + sender. Checks userMap first, then falls back to channel:senderId. */
export function channelUid(msg: IncomingMessage): string {
  const key = `${msg.channel}:${msg.senderId}`;
  const mapped = _channelUserMap.get(key);
  if (mapped) {
    logDim(msg.channel, `UID mapped: ${msg.senderId} → ${mapped}`);
    return mapped;
  }
  return key;
}

/** Generate a session key scoped to channel + chat (not just user — separate group vs DM sessions). */
export function channelSessionKey(msg: IncomingMessage) {
  return {
    uid: channelUid(msg),
    surface: "chat" as const,
    surfaceId: `${msg.channel}:${msg.chatId}`,
  };
}

/** Auto-create a user row for channel users so sessions FK constraint is satisfied. */
async function ensureChannelUser(uid: string, displayName: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [uid, `${uid}@channel`, "channel", displayName || "Channel User"],
  );
}

/** Resolve which agent should handle a given chat. Checks routing table, then falls back to default. */
async function resolveAgentForChat(msg: IncomingMessage): Promise<string> {
  // 1. Check per-chat routing (set via /switch command)
  const mapped = await getChannelAgentMapping(msg.channel, msg.chatId);
  if (mapped) return mapped;

  // 2. Check per-channel default
  const channelDefault = await getChannelAgentMapping(msg.channel, "*");
  if (channelDefault) return channelDefault;

  // 3. Global default
  return getDefaultAgentId();
}
