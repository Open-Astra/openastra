import type { InferenceClient } from "../inference/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("self-critique");

// ── Types ────────────────────────────────────────────────────────────

export interface CritiqueResult {
  original: string;
  critiques: string[];
  revised: string;
  passes: number;
  durationMs: number;
}

// ── Main Self-Critique Function ──────────────────────────────────────

export async function runSelfCritique(
  response: string,
  inferenceClient: InferenceClient,
  maxTokens: number,
  passes: number = 1,
): Promise<CritiqueResult> {
  const startTime = Date.now();
  const critiques: string[] = [];
  let currentResponse = response;
  let passCount = 0;

  try {
    for (let pass = 0; pass < passes; pass++) {
      // Run critique pass
      const critiquePrompt = buildCritiquePrompt(currentResponse);
      const critiqueResponse = await inferenceClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are a critical evaluator. Analyze the response below for accuracy, completeness, tone, and clarity. Be concise.",
          },
          {
            role: "user",
            content: critiquePrompt,
          },
        ],
        temperature: 0.3,
        maxTokens: Math.min(500, maxTokens),
      });

      const critiqueText = critiqueResponse.content ?? "";
      if (critiqueText) {
        critiques.push(critiqueText);
      }

      // Check if critique identifies significant issues
      if (!hasIssues(critiqueText)) {
        // No issues found, stop here
        passCount = pass + 1;
        break;
      }

      // Run revision pass if issues found and we haven't exhausted passes
      if (pass < passes - 1) {
        const revisionPrompt = buildRevisionPrompt(currentResponse, critiqueText);
        const revisionResponse = await inferenceClient.chat({
          messages: [
            {
              role: "system",
              content:
                "You are an expert editor. Based on the feedback, revise the response to be more accurate, complete, and clear. Keep the same structure but improve content.",
            },
            {
              role: "user",
              content: revisionPrompt,
            },
          ],
          temperature: 0.5,
          maxTokens,
        });

        if (revisionResponse.content) {
          currentResponse = revisionResponse.content;
          passCount = pass + 1;
        } else {
          // Revision failed, use original
          break;
        }
      } else {
        passCount = pass + 1;
      }
    }

    const durationMs = Date.now() - startTime;

    log.info(
      `Self-critique completed passes=${passCount} critiques=${critiques.length} durationMs=${durationMs}`,
    );

    return {
      original: response,
      critiques,
      revised: currentResponse,
      passes: passCount,
      durationMs,
    };
  } catch (err) {
    log.error(`Self-critique failed error=${String(err)}`);
    // Return original response on error
    return {
      original: response,
      critiques,
      revised: response,
      passes: passCount,
      durationMs: Date.now() - startTime,
    };
  }
}

// ── Helper Functions ────────────────────────────────────────────────

function buildCritiquePrompt(response: string): string {
  return `Evaluate this response:

"${response.slice(0, 2000)}"

Provide a brief assessment covering:
1. Accuracy: Are facts correct?
2. Completeness: Does it fully address the request?
3. Tone: Is the tone appropriate?
4. Clarity: Is it clear and well-structured?

If you identify any issues, list them. If the response is good, say "No issues identified."`;
}

function buildRevisionPrompt(original: string, critique: string): string {
  return `Original response:
"${original.slice(0, 1500)}"

Feedback:
${critique.slice(0, 500)}

Please revise the response to address the feedback above.`;
}

function hasIssues(critiqueText: string): boolean {
  const lowerCritique = critiqueText.toLowerCase();

  // Check for explicit markers that issues were identified
  const issueMarkers = [
    "issue",
    "problem",
    "incorrect",
    "inaccurate",
    "missing",
    "incomplete",
    "unclear",
    "confusing",
    "concern",
    "error",
    "wrong",
  ];

  // Check if any issue markers appear
  for (const marker of issueMarkers) {
    if (lowerCritique.includes(marker)) {
      // Make sure it's not negated
      const markerIndex = lowerCritique.indexOf(marker);
      const before = lowerCritique.slice(Math.max(0, markerIndex - 10), markerIndex);
      if (!before.includes("no ") && !before.includes("none")) {
        return true;
      }
    }
  }

  // Check if critique explicitly says "no issues"
  if (
    lowerCritique.includes("no issues") ||
    lowerCritique.includes("no problems") ||
    lowerCritique.includes("all good")
  ) {
    return false;
  }

  return false;
}
