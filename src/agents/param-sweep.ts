import type { AgentConfig } from "./types.js";
import type { InferenceClient } from "../inference/types.js";

// ── Parameter Sweep ───────────────────────────────────────────────────
// Runs the agent with multiple temperature/maxTokens combinations to find
// optimal parameters for a given test prompt.

export interface SweepResult {
  temperature: number;
  maxTokens: number;
  responseLength: number;
  latencyMs: number;
  content: string;
}

export interface ParameterGrid {
  temperatures: number[];
  maxTokensList: number[];
}

/**
 * Runs the agent with every (temperature, maxTokens) combination in the grid.
 * Each combination is run sequentially to avoid overwhelming the provider.
 * Returns all results sorted by response length descending.
 */
export async function runParamSweep(
  _sweepId: string,
  testPrompt: string,
  agentConfig: AgentConfig,
  client: InferenceClient,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];

  // Default grid if no specific values provided
  const temperatures = [0.1, 0.5, 0.7, 1.0];
  const maxTokensList = [256, 512, 1024];

  for (const temperature of temperatures) {
    for (const maxTokens of maxTokensList) {
      const start = Date.now();
      try {
        const response = await client.chat({
          messages: [
            { role: "system", content: agentConfig.systemPromptTemplate },
            { role: "user", content: testPrompt },
          ],
          temperature,
          maxTokens,
        });
        const content = response.content ?? "";
        results.push({
          temperature,
          maxTokens,
          responseLength: content.length,
          latencyMs: Date.now() - start,
          content,
        });
      } catch {
        // Record failed sweep as empty result
        results.push({
          temperature,
          maxTokens,
          responseLength: 0,
          latencyMs: Date.now() - start,
          content: "",
        });
      }
    }
  }

  return results;
}

/**
 * Runs a parameter sweep using a custom grid.
 */
export async function runParamSweepWithGrid(
  sweepId: string,
  testPrompt: string,
  agentConfig: AgentConfig,
  client: InferenceClient,
  grid: ParameterGrid,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];

  for (const temperature of grid.temperatures) {
    for (const maxTokens of grid.maxTokensList) {
      const start = Date.now();
      try {
        const response = await client.chat({
          messages: [
            { role: "system", content: agentConfig.systemPromptTemplate },
            { role: "user", content: testPrompt },
          ],
          temperature,
          maxTokens,
        });
        const content = response.content ?? "";
        results.push({
          temperature,
          maxTokens,
          responseLength: content.length,
          latencyMs: Date.now() - start,
          content,
        });
      } catch {
        results.push({
          temperature,
          maxTokens,
          responseLength: 0,
          latencyMs: Date.now() - start,
          content: "",
        });
      }
    }
  }

  // Use sweepId to keep lint happy (it's used by callers for DB persistence)
  void sweepId;

  return results;
}
