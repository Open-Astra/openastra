import type { MessageDoc } from "../sessions/types.js";

// ── Context Segmentation ──────────────────────────────────────────────
// Segments conversation history into labeled topic windows to improve
// retrieval relevance and context assembly.

export type SegmentLabel = "planning" | "execution" | "review" | "off-topic";

export interface ContextSegment {
  label: SegmentLabel;
  startIndex: number;
  endIndex: number;
  messages: MessageDoc[];
}

// ── Segment Classification Keywords ─────────────────────────────────

const PLANNING_KEYWORDS = [
  "plan", "goal", "objective", "strategy", "approach", "steps",
  "outline", "structure", "organize", "design", "scope", "requirements",
  "let's", "we should", "we need to", "first", "then", "next",
];

const EXECUTION_KEYWORDS = [
  "run", "execute", "create", "build", "implement", "write", "generate",
  "fetch", "query", "call", "send", "upload", "download", "deploy",
  "install", "configure", "update", "delete", "edit", "modify",
];

const REVIEW_KEYWORDS = [
  "review", "check", "verify", "confirm", "validate", "test",
  "looks good", "correct", "wrong", "error", "issue", "problem",
  "improve", "better", "refine", "revise", "fix", "debug",
  "summarize", "summary", "conclusion", "result", "output",
];

/**
 * Classifies a message (by its content) into one of the segment labels.
 */
function classifyMessage(content: string): SegmentLabel {
  const lower = content.toLowerCase();
  const planScore = PLANNING_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const execScore = EXECUTION_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const reviewScore = REVIEW_KEYWORDS.filter((kw) => lower.includes(kw)).length;

  const maxScore = Math.max(planScore, execScore, reviewScore);
  if (maxScore === 0) return "off-topic";
  if (maxScore === planScore) return "planning";
  if (maxScore === execScore) return "execution";
  return "review";
}

/**
 * Groups consecutive messages with the same label into segments.
 * Adjacent messages with different labels start new segments.
 *
 * Example output:
 *   [{ label: "planning", startIndex: 0, endIndex: 3, messages: [...] },
 *    { label: "execution", startIndex: 4, endIndex: 9, messages: [...] }]
 */
export function segmentContext(messages: MessageDoc[]): ContextSegment[] {
  if (messages.length === 0) return [];

  const segments: ContextSegment[] = [];
  let currentLabel: SegmentLabel | null = null;
  let segmentStart = 0;
  let segmentMessages: MessageDoc[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Only classify user/assistant messages; tool results inherit parent label
    const label: SegmentLabel =
      msg.role === "user" || msg.role === "assistant"
        ? classifyMessage(msg.content)
        : currentLabel ?? "off-topic";

    if (currentLabel === null) {
      currentLabel = label;
      segmentStart = i;
      segmentMessages = [msg];
    } else if (label === currentLabel) {
      segmentMessages.push(msg);
    } else {
      // Flush current segment
      segments.push({
        label: currentLabel,
        startIndex: segmentStart,
        endIndex: i - 1,
        messages: segmentMessages,
      });
      currentLabel = label;
      segmentStart = i;
      segmentMessages = [msg];
    }
  }

  // Flush last segment
  if (segmentMessages.length > 0 && currentLabel !== null) {
    segments.push({
      label: currentLabel,
      startIndex: segmentStart,
      endIndex: messages.length - 1,
      messages: segmentMessages,
    });
  }

  return segments;
}

/**
 * Returns the most recent (active) segment, or null if there are none.
 */
export function getActiveSegment(segments: ContextSegment[]): ContextSegment | null {
  if (segments.length === 0) return null;
  return segments[segments.length - 1] ?? null;
}
