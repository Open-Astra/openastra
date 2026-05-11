// ── Agent Whispering ─────────────────────────────────────────────────
// Inject hidden context into a single agent turn without persisting it
// in the session history. Transmitted via X-Agent-Whisper header (base64).

import type { Request } from "express";
import type { ChatMessage } from "../inference/types.js";

const WHISPER_HEADER = "x-agent-whisper";

/**
 * Extract the whisper string from request headers.
 * The header value is expected to be base64-encoded UTF-8.
 */
export function extractWhisper(req: Request): string | null {
  const raw = req.headers[WHISPER_HEADER];
  if (!raw || typeof raw !== "string") return null;
  try {
    return Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Inject the whisper as a hidden system message immediately before the
 * last user message. The whisper is NOT stored in the session.
 */
export function applyWhisper(messages: ChatMessage[], whisper: string): ChatMessage[] {
  const whisperMessage: ChatMessage = {
    role: "system",
    content: `[WHISPER — visible to you only, not stored] ${whisper}`,
  };

  // Find the index of the last user message
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex === -1) {
    // No user message — append at end
    return [...messages, whisperMessage];
  }

  return [
    ...messages.slice(0, lastUserIndex),
    whisperMessage,
    ...messages.slice(lastUserIndex),
  ];
}
