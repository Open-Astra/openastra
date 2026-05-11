// ── Adaptive Context Compression ─────────────────────────────────────
// Drops oldest non-system messages when context exceeds token budget.
// Always preserves system messages and the last N exchanges.

import type { ChatMessage } from "../inference/types.js";

const CHARS_PER_TOKEN = 4;
const MIN_PRESERVED_EXCHANGES = 4; // always keep last 4 user+assistant pairs

/** Rough token estimate for a single message. */
export function estimateMessageTokens(msg: ChatMessage): number {
  const contentLen = typeof msg.content === "string" ? msg.content.length : 0;
  return Math.ceil(contentLen / CHARS_PER_TOKEN) + 4; // +4 for role overhead
}

/** Total estimated tokens across all messages. */
export function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Compress messages so that total token count fits within budget.
 *
 * Strategy:
 * 1. Never drop system messages.
 * 2. Always keep the last MIN_PRESERVED_EXCHANGES user+assistant pairs.
 * 3. Drop the oldest droppable messages first.
 *
 * @param messages    Full message array.
 * @param maxTokens   Maximum allowed total tokens.
 * @param reserveTokens Tokens to reserve for the next response.
 * @returns Compressed message array (may be unchanged if already within budget).
 */
export function compressIfNeeded(
  messages: ChatMessage[],
  maxTokens: number,
  reserveTokens: number = 1000,
): ChatMessage[] {
  const budget = maxTokens - reserveTokens;
  if (estimateTotalTokens(messages) <= budget) return messages;

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // Identify the tail we must preserve
  const tailCount = Math.min(MIN_PRESERVED_EXCHANGES * 2, nonSystemMessages.length);
  const tail = nonSystemMessages.slice(-tailCount);
  const droppable = nonSystemMessages.slice(0, -tailCount);

  const systemTokens = systemMessages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  const tailTokens = tail.reduce((s, m) => s + estimateMessageTokens(m), 0);

  let available = budget - systemTokens - tailTokens;
  const kept: ChatMessage[] = [];

  // Try to include as many droppable messages from the end as possible
  for (let i = droppable.length - 1; i >= 0; i--) {
    const msg = droppable[i]!;
    const tokens = estimateMessageTokens(msg);
    if (available - tokens >= 0) {
      kept.unshift(msg);
      available -= tokens;
    }
  }

  return [...systemMessages, ...kept, ...tail];
}
