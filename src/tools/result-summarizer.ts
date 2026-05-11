import type { InferenceClient } from "../inference/types.js";

// ── Tool Result Summarizer ────────────────────────────────────────
// Summarizes verbose tool results before they enter the context window.
// Only triggers above a character threshold — short results pass through.
// Uses a fast model to compress while preserving key information.

const SUMMARIZE_THRESHOLD = 3000; // chars

export function shouldSummarize(content: string): boolean {
  return content.length > SUMMARIZE_THRESHOLD;
}

export async function summarizeToolResult(
  toolName: string,
  rawResult: string,
  inferenceClient: InferenceClient,
): Promise<string> {
  if (!shouldSummarize(rawResult)) return rawResult;

  try {
    const response = await inferenceClient.chat({
      messages: [
        {
          role: "system",
          content:
            "You are a concise summarizer. Compress the following tool output into a brief summary preserving all key facts, numbers, and actionable information. Output only the summary, no preamble.",
        },
        {
          role: "user",
          content: `Tool: ${toolName}\n\nOutput (${rawResult.length} chars):\n${rawResult.slice(0, 6000)}`,
        },
      ],
      temperature: 0,
      maxTokens: 500,
    });

    const summary = response.content?.trim();
    if (summary && summary.length < rawResult.length * 0.8) {
      return `[Summarized from ${rawResult.length} chars]\n${summary}`;
    }
  } catch {
    // Summarization failed — return truncated original
  }

  // Fallback: truncate with marker
  return rawResult.slice(0, SUMMARIZE_THRESHOLD) +
    `\n...[truncated, ${rawResult.length} total chars]`;
}
