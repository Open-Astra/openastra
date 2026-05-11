// ── Token Budget Predictor (Feature 2) ──────────────────────────────
// Predicts token usage for a given agent + model + message length.
// Uses historical data and model-specific token counters to estimate
// both prompt and completion tokens before inference.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("token-budget-predictor");

export interface TokenEstimate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  confidence: number; // 0.0 to 1.0, higher = more reliable
}

export interface TokenPredictionStats {
  agentId: string;
  model: string;
  samples: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  p95TotalTokens: number;
  maxTotalTokens: number;
}

const CHARS_PER_TOKEN = 4; // Heuristic: ~4 chars per token
const MIN_HISTORY_FOR_CONFIDENCE = 5;

/**
 * Predict token usage for a given agent/model combination.
 * Uses historical data if available, falls back to character-based heuristic.
 * @param agentId Agent identifier
 * @param model Model identifier (e.g., "gpt-4o", "claude-3-opus")
 * @param messageLength Approximate length of input in characters
 * @returns Token estimate with confidence score
 */
export async function predictTokenUsage(
  agentId: string,
  model: string,
  messageLength: number,
): Promise<TokenEstimate> {
  try {
    const pool = getPool();

    // Query historical estimates for this agent+model combination
    const result = await pool.query<{
      count: string;
      avg_prompt_tokens: string;
      avg_completion_tokens: string;
    }>(
      `SELECT
         COUNT(*) as count,
         ROUND(AVG(prompt_tokens)) as avg_prompt_tokens,
         ROUND(AVG(completion_tokens)) as avg_completion_tokens
       FROM token_estimates
       WHERE agent_id = $1 AND model = $2
       AND recorded_at > NOW() - INTERVAL '30 days'`,
      [agentId, model],
    );

    if (result.rows.length > 0 && result.rows[0]) {
      const row = result.rows[0];
      const count = parseInt(row.count, 10);

      if (count >= MIN_HISTORY_FOR_CONFIDENCE) {
        // We have sufficient history — use averages
        const avgPromptTokens = parseInt(row.avg_prompt_tokens, 10);
        const avgCompletionTokens = parseInt(row.avg_completion_tokens, 10);

        // Adjust prompt estimate based on actual message length
        const inputTokenEstimate = Math.max(
          Math.ceil(messageLength / CHARS_PER_TOKEN),
          avgPromptTokens * 0.5, // At least half the average
        );

        return {
          promptTokens: inputTokenEstimate,
          completionTokens: avgCompletionTokens,
          totalTokens: inputTokenEstimate + avgCompletionTokens,
          confidence: Math.min(1.0, count / 50), // Scale confidence by sample count
        };
      }
    }

    // Fallback: use character-based heuristic
    const estimatedPrompt = Math.ceil(messageLength / CHARS_PER_TOKEN);
    const estimatedCompletion = Math.ceil(estimatedPrompt * 0.25);

    return {
      promptTokens: estimatedPrompt,
      completionTokens: estimatedCompletion,
      totalTokens: estimatedPrompt + estimatedCompletion,
      confidence: 0.3, // Low confidence for heuristic
    };
  } catch (err) {
    log.warn(
      `Token prediction failed for ${agentId}/${model}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Return conservative heuristic on error
    const estimatedPrompt = Math.ceil(messageLength / CHARS_PER_TOKEN);
    return {
      promptTokens: estimatedPrompt,
      completionTokens: Math.ceil(estimatedPrompt * 0.25),
      totalTokens: Math.ceil(estimatedPrompt * 1.25),
      confidence: 0.1,
    };
  }
}

/**
 * Get statistical summary of token predictions for an agent.
 * @param agentId Agent identifier
 * @returns Token prediction statistics across all models
 */
export async function getTokenPredictionStats(agentId: string): Promise<TokenPredictionStats> {
  try {
    const pool = getPool();

    const result = await pool.query<{
      model: string;
      count: string;
      avg_prompt: string;
      avg_completion: string;
      p95_total: string;
      max_total: string;
    }>(
      `SELECT
         model,
         COUNT(*) as count,
         ROUND(AVG(prompt_tokens)) as avg_prompt,
         ROUND(AVG(completion_tokens)) as avg_completion,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_tokens)) as p95_total,
         MAX(total_tokens) as max_total
       FROM token_estimates
       WHERE agent_id = $1
       AND recorded_at > NOW() - INTERVAL '30 days'
       GROUP BY model
       ORDER BY count DESC
       LIMIT 1`,
      [agentId],
    );

    if (result.rows.length > 0 && result.rows[0]) {
      const row = result.rows[0];
      return {
        agentId,
        model: row.model,
        samples: parseInt(row.count, 10),
        avgPromptTokens: parseInt(row.avg_prompt, 10),
        avgCompletionTokens: parseInt(row.avg_completion, 10),
        p95TotalTokens: parseInt(row.p95_total, 10),
        maxTotalTokens: parseInt(row.max_total, 10),
      };
    }

    // No data available
    return {
      agentId,
      model: "unknown",
      samples: 0,
      avgPromptTokens: 0,
      avgCompletionTokens: 0,
      p95TotalTokens: 0,
      maxTotalTokens: 0,
    };
  } catch (err) {
    log.warn(`Token stats query failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      agentId,
      model: "unknown",
      samples: 0,
      avgPromptTokens: 0,
      avgCompletionTokens: 0,
      p95TotalTokens: 0,
      maxTotalTokens: 0,
    };
  }
}

/**
 * Record actual token usage for future prediction refinement.
 * Should be called after each inference.
 * @param agentId Agent identifier
 * @param model Model identifier
 * @param messageLength Message length in characters
 * @param promptTokens Actual prompt tokens used
 * @param completionTokens Actual completion tokens used
 */
export async function recordTokenUsage(
  agentId: string,
  model: string,
  messageLength: number,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO token_estimates
         (agent_id, model, message_length_tokens, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, model, messageLength, promptTokens, completionTokens, promptTokens + completionTokens],
    );
  } catch (err) {
    log.dim(`Token usage record failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
