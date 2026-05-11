import type { MessageDoc } from "./types.js";

// ── Context Pruning ────────────────────────────────────────────────
// Per the OpenClaw spec: "trims old tool results from in-memory context
// before LLM calls without rewriting the persisted transcript."
//
// This is a pure function — it returns new message objects and does
// NOT modify the originals. The persisted Firestore transcript stays
// intact.

const CHARS_PER_TOKEN = 4;

// ── Prune Tool Results ─────────────────────────────────────────────
// For messages older than the last 5 turns:
// - role === "tool": replace content with a brief summary
// - role === "assistant" with toolCalls: keep call names, strip arguments
// Recent messages (last 5 turns) are left untouched.

export function pruneToolResults(messages: MessageDoc[]): MessageDoc[] {
  if (messages.length <= 5) return messages;

  const cutoff = messages.length - 5;

  return messages.map((msg, i) => {
    // Recent messages — pass through unchanged
    if (i >= cutoff) return msg;

    // Old tool result messages — replace with summary
    if (msg.role === "tool") {
      const toolName = msg.toolCallId ?? "unknown";
      const contentLength = msg.content.length;
      return {
        ...msg,
        content: `[Tool: ${toolName} returned ${contentLength} chars]`,
        tokenEstimate: Math.ceil(
          `[Tool: ${toolName} returned ${contentLength} chars]`.length / CHARS_PER_TOKEN,
        ),
      };
    }

    // Old assistant messages with tool calls — strip arguments to save tokens
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: "{}",
          // Preserve thoughtSignature — Gemini thinking models require it
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        })),
      };
    }

    // All other old messages — pass through unchanged
    return msg;
  });
}

// ── Deduplicate Repeated Tool Results ─────────────────────────────
// When the same tool is called multiple times with highly overlapping
// results, replace older results with a compact marker. Keeps the most
// recent result intact.

export function deduplicateToolResults(messages: MessageDoc[]): MessageDoc[] {
  // Group tool results by tool name (from toolCallId or preceding assistant msg)
  const toolResults: Array<{ index: number; name: string; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;

    // Find the tool name from the preceding assistant's toolCalls
    let toolName = "unknown";
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]!;
      if (prev.role === "assistant" && prev.toolCalls?.length) {
        const tc = prev.toolCalls.find((t) => t.id === msg.toolCallId);
        if (tc) { toolName = tc.name; break; }
      }
    }
    toolResults.push({ index: i, name: toolName, content: msg.content });
  }

  // Find duplicates: same tool, >80% content overlap
  const deduped = new Set<number>();

  for (let i = 0; i < toolResults.length; i++) {
    const a = toolResults[i]!;
    if (deduped.has(a.index)) continue;

    for (let j = i + 1; j < toolResults.length; j++) {
      const b = toolResults[j]!;
      if (a.name !== b.name || deduped.has(b.index)) continue;

      const overlap = computeOverlap(a.content, b.content);
      if (overlap > 0.8) {
        // Mark the older one (a) for dedup, keep the newer one (b)
        deduped.add(a.index);
        break;
      }
    }
  }

  if (deduped.size === 0) return messages;

  return messages.map((msg, i) => {
    if (!deduped.has(i)) return msg;
    const chars = msg.content.length;
    const toolName = msg.toolCallId ?? "tool";
    return {
      ...msg,
      content: `[Tool: ${toolName} returned similar results, ${chars} chars, deduplicated]`,
      tokenEstimate: Math.ceil(60 / CHARS_PER_TOKEN),
    };
  });
}

function computeOverlap(a: string, b: string): number {
  // Fast character-level Jaccard approximation using 4-char shingles
  if (a.length < 20 || b.length < 20) return 0;

  const shingleA = new Set<string>();
  const shingleB = new Set<string>();

  for (let i = 0; i <= a.length - 4; i += 4) shingleA.add(a.slice(i, i + 4));
  for (let i = 0; i <= b.length - 4; i += 4) shingleB.add(b.slice(i, i + 4));

  let intersection = 0;
  for (const s of shingleA) {
    if (shingleB.has(s)) intersection++;
  }

  const union = shingleA.size + shingleB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Estimate Context Tokens ────────────────────────────────────────
// Sum up all message token estimates for budget tracking.

export function estimateContextTokens(messages: MessageDoc[]): number {
  return messages.reduce((sum, msg) => sum + msg.tokenEstimate, 0);
}
