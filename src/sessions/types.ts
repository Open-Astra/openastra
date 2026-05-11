import { z } from "zod";
import type { AgentId } from "../agents/types.js";

// ── Session Key ─────────────────────────────────────────────────────
// Derived from uid + surface + context, matching OpenClaw's
// channel + peer → session key resolution.

export const SessionSurface = z.enum(["chat", "prop", "group", "heartbeat"]);
export type SessionSurface = z.infer<typeof SessionSurface>;

export interface SessionKey {
  uid: string;
  surface: SessionSurface;
  surfaceId: string; // "main", propId, threadId, etc.
}

// ── Session Document ────────────────────────────────────────────────
// Stored at users/{uid}/agent/sessions/{sessionId}

export interface MemoryFilter {
  allowTiers?: number[];
  denyTags?: string[];
}

export interface SessionDoc {
  id: string;
  key: SessionKey;
  agentId: AgentId;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  tokenCount: number;
  status: "active" | "compacted" | "archived";
  compactionSummary?: string;
  webhookUrl?: string;
  memoryFilter?: MemoryFilter;
}

// ── Message Document ────────────────────────────────────────────────
// Stored at users/{uid}/agent/sessions/{sessionId}/messages/{messageId}

export interface MessageDoc {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string; // JSON string
    thoughtSignature?: string; // Gemini 3.0: encrypted reasoning state
  }>;
  toolCallId?: string; // for role=tool, which call this responds to
  tokenEstimate: number;
  timestamp: number;
}

// ── Session Resolution Result ───────────────────────────────────────

export interface ResolvedSession {
  session: SessionDoc;
  messages: MessageDoc[];
  isNew: boolean;
  memoryFilter?: MemoryFilter;
}
