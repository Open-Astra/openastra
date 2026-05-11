import type { ChatMessage, InferenceClient } from "../inference/types.js";
import { createLogger } from "../utils/logger.js";

// ── Conversation Window Manager ─────────────────────────────────────
// Manages the sliding context window for agent conversations.
// Prevents unbounded context growth while preserving important context.
//
// Strategy:
//   1. Always keep the system prompt and first user message
//   2. Keep the last N messages (configurable)
//   3. When window overflows, summarize evicted messages
//   4. Insert summary as a system message after the system prompt
//   5. Preserve all tool call/result pairs (never split them)

const log = createLogger("window-manager");

export interface WindowConfig {
  maxTokens: number;        // Max total tokens in context
  maxMessages: number;      // Max messages to keep
  summaryModel?: InferenceClient; // Model to generate summaries (optional)
  preserveToolPairs: boolean; // Keep tool call + result together
}

export interface WindowState {
  messages: ChatMessage[];
  summaries: string[];     // Accumulated summaries of evicted messages
  totalEvicted: number;    // How many messages have been evicted total
  estimatedTokens: number;
}

const DEFAULT_CONFIG: WindowConfig = {
  maxTokens: 100_000,
  maxMessages: 50,
  preserveToolPairs: true,
};

/**
 * Estimate token count for a message (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(msg: ChatMessage): number {
  let size = (msg.content?.length ?? 0) / 4;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      size += (tc.function.name.length + tc.function.arguments.length) / 4;
    }
  }
  return Math.ceil(size + 4); // +4 for role/overhead
}

/**
 * Generate a summary of evicted messages using an LLM.
 */
async function summarizeMessages(
  messages: ChatMessage[],
  client: InferenceClient,
): Promise<string> {
  const text = messages
    .filter((m) => m.content)
    .map((m) => `[${m.role}] ${m.content!.slice(0, 500)}`)
    .join("\n");

  if (text.length < 50) return "";

  try {
    const response = await client.chat({
      messages: [
        {
          role: "system",
          content: "Summarize the following conversation excerpt in 2-3 sentences. Focus on key decisions, outcomes, and context that would be important for continuing the conversation. Be concise.",
        },
        { role: "user", content: text.slice(0, 3000) },
      ],
      temperature: 0.3,
      maxTokens: 200,
    });

    return response.content ?? "";
  } catch (err) {
    log.dim("Summary generation failed:", err instanceof Error ? err.message : "");
    // Fallback: extract key sentences
    return messages
      .filter((m) => m.role === "assistant" && m.content)
      .slice(-3)
      .map((m) => m.content!.slice(0, 100))
      .join(". ");
  }
}

/**
 * Create a new window state from initial messages.
 */
export function createWindowState(messages: ChatMessage[] = []): WindowState {
  return {
    messages,
    summaries: [],
    totalEvicted: 0,
    estimatedTokens: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
  };
}

/**
 * Add a message to the window, evicting old messages if needed.
 */
export async function addMessage(
  state: WindowState,
  message: ChatMessage,
  config: WindowConfig = DEFAULT_CONFIG,
): Promise<WindowState> {
  const newTokens = estimateTokens(message);
  const newMessages = [...state.messages, message];
  let newEstimated = state.estimatedTokens + newTokens;

  // Check if we need to evict
  if (newMessages.length <= config.maxMessages && newEstimated <= config.maxTokens) {
    return { ...state, messages: newMessages, estimatedTokens: newEstimated };
  }

  // Find eviction boundary: keep system prompt + first user msg at minimum
  let keepFrom = 0;
  if (newMessages[0]?.role === "system") keepFrom = 1;
  if (newMessages[keepFrom]?.role === "user") keepFrom++;

  // Calculate how many messages to evict (keep last N within budget)
  const targetMessages = Math.min(config.maxMessages, newMessages.length);
  let evictTo = Math.max(keepFrom, newMessages.length - targetMessages);

  // Ensure we don't split tool call/result pairs
  if (config.preserveToolPairs) {
    while (evictTo < newMessages.length && newMessages[evictTo]?.role === "tool") {
      evictTo--;
    }
  }

  if (evictTo <= keepFrom) {
    // Nothing to evict; just return with the new message
    return { ...state, messages: newMessages, estimatedTokens: newEstimated };
  }

  const evictedMessages = newMessages.slice(keepFrom, evictTo);
  const keptPrefix = newMessages.slice(0, keepFrom);
  const keptSuffix = newMessages.slice(evictTo);

  // Generate summary of evicted messages
  let newSummary = "";
  if (config.summaryModel && evictedMessages.length > 3) {
    newSummary = await summarizeMessages(evictedMessages, config.summaryModel);
  } else if (evictedMessages.length > 0) {
    // Extractive fallback: keep key assistant messages
    newSummary = evictedMessages
      .filter((m) => m.role === "assistant" && m.content)
      .slice(-2)
      .map((m) => m.content!.slice(0, 200))
      .join(". ");
  }

  const summaries = [...state.summaries];
  if (newSummary) summaries.push(newSummary);

  // Inject summary as a system message after the system prompt
  const summaryMessage: ChatMessage | null = summaries.length > 0
    ? {
        role: "system",
        content: `[Previous conversation summary]\n${summaries.slice(-3).join("\n\n")}`,
      }
    : null;

  const finalMessages = [
    ...keptPrefix,
    ...(summaryMessage ? [summaryMessage] : []),
    ...keptSuffix,
  ];

  newEstimated = finalMessages.reduce((sum, m) => sum + estimateTokens(m), 0);

  log.dim(`Window: evicted ${evictedMessages.length} messages, ${finalMessages.length} remain (~${newEstimated} tokens)`);

  return {
    messages: finalMessages,
    summaries,
    totalEvicted: state.totalEvicted + evictedMessages.length,
    estimatedTokens: newEstimated,
  };
}

/**
 * Get the messages formatted for an inference request.
 */
export function getRequestMessages(state: WindowState): ChatMessage[] {
  return state.messages;
}
