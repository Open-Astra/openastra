// ── Synthetic Transaction Monitor ──────────────────────────────────────
// Runs synthetic transactions on each provider to test health and latency.
// Results are persisted for dashboarding and alerting.

import { getPool } from "../config/postgres.js";
import { warmUpAll } from "../inference/warm-pool-probe.js";
import { createLogger } from "../utils/logger.js";
import { z } from "zod";

const log = createLogger("synthetic-tx");

// ── Types ─────────────────────────────────────────────────────────────

const SyntheticTxResultSchema = z.object({
  id: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  latency_ms: z.number(),
  success: z.boolean(),
  error: z.string().nullable(),
  run_at: z.date().optional(),
});

export type SyntheticTxResult = z.infer<typeof SyntheticTxResultSchema>;

// ── Helper: Get Configured Providers ────────────────────────────────
function getConfiguredProviders(): Array<{ provider: string; modelId: string; endpoint?: string }> {
  const providers: Array<{ provider: string; modelId: string; endpoint?: string }> = [];

  if (process.env.OPENAI_API_KEY) providers.push({ provider: "openai", modelId: "gpt-4o-mini" });
  if (process.env.ANTHROPIC_API_KEY) providers.push({ provider: "claude", modelId: "claude-haiku-4-5-20251001" });
  if (process.env.GEMINI_API_KEY) providers.push({ provider: "gemini", modelId: "gemini-1.5-flash" });
  if (process.env.GROK_API_KEY) providers.push({ provider: "grok", modelId: "grok-2" });
  if (process.env.GROQ_API_KEY) providers.push({ provider: "groq", modelId: "llama-3.3-70b-versatile" });
  if (process.env.OLLAMA_BASE_URL) providers.push({ provider: "ollama", modelId: "llama3.2" });

  return providers;
}

// ── Run Synthetic Transactions ─────────────────────────────────────────

export async function runSyntheticTransactions(): Promise<void> {
  const pool = getPool();
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    log.warn("No configured providers for synthetic transactions");
    return;
  }

  try {
    const results = await warmUpAll({ providers });

    for (const result of results) {
      await pool.query(
        `INSERT INTO synthetic_tx_results (provider, model, latency_ms, success, error, run_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          result.provider,
          result.model,
          result.latencyMs,
          result.success,
          result.error ?? null,
        ],
      );
    }

    log.info(`Synthetic transactions completed: ${results.length} providers`);
  } catch (err) {
    log.error("Failed to run synthetic transactions:", err);
  }
}

// ── Get Recent Results ──────────────────────────────────────────────────

export async function getRecentSyntheticResults(limit: number = 50): Promise<SyntheticTxResult[]> {
  const pool = getPool();

  try {
    const { rows } = await pool.query<SyntheticTxResult>(
      `SELECT id, provider, model, latency_ms, success, error, run_at
       FROM synthetic_tx_results
       ORDER BY run_at DESC
       LIMIT $1`,
      [limit],
    );

    return rows;
  } catch (err) {
    log.error("Failed to get synthetic transaction results:", err);
    return [];
  }
}
