import type { InferenceClient } from "../inference/types.js";

// ── Response Reflection / Self-Evaluation ────────────────────────
// Optional post-generation step where the agent evaluates its own
// response quality. Returns a confidence score and optional
// suggested improvements.
//
// This is designed to be called selectively — e.g., only on high-stakes
// tool-using turns or when the response seems uncertain.
//
// Not called by default in the main loop to avoid doubling inference
// costs. The agent or orchestrator can invoke this explicitly.

export interface ReflectionResult {
  confidence: number;       // 0-1 how confident the agent is in its response
  issues: string[];         // identified problems
  suggestions: string[];    // potential improvements
  shouldRevise: boolean;    // whether the response warrants revision
}

const REFLECTION_PROMPT = `You are evaluating the quality of an AI assistant's response. Review the conversation and the assistant's final response, then provide a brief assessment.

Rate the response on these dimensions:
1. Accuracy: Are the facts and reasoning correct?
2. Completeness: Does it fully address the user's request?
3. Actionability: Can the user act on this information?
4. Clarity: Is it clear and well-structured?

Respond in JSON format:
{
  "confidence": <0.0-1.0>,
  "issues": ["<issue1>", ...],
  "suggestions": ["<suggestion1>", ...],
  "shouldRevise": <true/false>
}

Only set shouldRevise=true for significant problems (wrong facts, missing critical info, harmful advice).`;

export async function reflectOnResponse(
  userMessage: string,
  assistantResponse: string,
  inferenceClient: InferenceClient,
  sessionId: string,
): Promise<ReflectionResult> {
  try {
    const response = await inferenceClient.chat({
      messages: [
        { role: "system", content: REFLECTION_PROMPT },
        { role: "user", content: `User asked: "${userMessage.slice(0, 500)}"` },
        { role: "assistant", content: assistantResponse.slice(0, 1000) },
        { role: "user", content: "Evaluate the above response." },
      ],
      temperature: 0.1,
      maxTokens: 300,
      sessionId,
    });

    const content = response.content ?? "";

    // Parse JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { confidence: 0.7, issues: [], suggestions: [], shouldRevise: false };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ReflectionResult>;

    return {
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.7)),
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 3) : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [],
      shouldRevise: parsed.shouldRevise === true,
    };
  } catch {
    // Reflection failure shouldn't block the response
    return { confidence: 0.5, issues: ["Reflection failed"], suggestions: [], shouldRevise: false };
  }
}

// ── Should Reflect? ──────────────────────────────────────────────
// Heuristic to decide when reflection is worthwhile.
// Called by the orchestrator or loop to conditionally trigger reflection.

export function shouldReflect(
  toolResults: Array<{ name: string; error?: string }>,
  responseLength: number,
): boolean {
  // Reflect if any tool errors occurred
  if (toolResults.some((r) => r.error)) return true;

  // Reflect on long responses (likely complex reasoning)
  if (responseLength > 2000) return true;

  // Reflect if many tools were used (complex multi-step)
  if (toolResults.length >= 3) return true;

  return false;
}
