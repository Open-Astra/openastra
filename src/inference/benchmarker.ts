// ── Provider Benchmarking ────────────────────────────────────────────
// Run the same prompt across multiple providers and compare latency/cost.

import { createPrimaryInferenceClient } from "./factory-internal.js";
import { estimateCost } from "../agents/cost-estimator.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("benchmarker");

export interface BenchmarkConfig {
  prompt: string;
  systemPrompt?: string;
  providers: Array<{ provider: string; modelId: string }>;
  warmupRuns?: number;
  timedRuns?: number;
}

export interface BenchmarkResult {
  provider: string;
  model: string;
  latencyMs: number[];
  p50Ms: number;
  p99Ms: number;
  avgTokensPerSecond: number;
  totalTokens: number;
  estimatedCostUsd: number;
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult[]> {
  const warmup = config.warmupRuns ?? 1;
  const timed = config.timedRuns ?? 3;
  const results: BenchmarkResult[] = [];

  for (const { provider, modelId } of config.providers) {
    logger.info(`Benchmarking ${provider}:${modelId}`);

    let client: ReturnType<typeof createPrimaryInferenceClient> | null = null;
    try {
      client = createPrimaryInferenceClient(provider, modelId);
    } catch (err) {
      results.push({
        provider, model: modelId,
        latencyMs: [], p50Ms: 0, p99Ms: 0,
        avgTokensPerSecond: 0, totalTokens: 0,
        estimatedCostUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const messages = [
      ...(config.systemPrompt ? [{ role: "system" as const, content: config.systemPrompt }] : []),
      { role: "user" as const, content: config.prompt },
    ];

    // Warm-up (not timed)
    for (let i = 0; i < warmup; i++) {
      try {
        await client.chat({ messages, maxTokens: 64 });
      } catch {
        // Ignore warm-up errors
      }
    }

    // Timed runs
    const latencies: number[] = [];
    let totalTokens = 0;
    let errorMsg: string | undefined;

    for (let i = 0; i < timed; i++) {
      const start = Date.now();
      try {
        const resp = await client.chat({ messages, maxTokens: 128 });
        latencies.push(Date.now() - start);
        totalTokens += resp.usage.totalTokens;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    latencies.sort((a, b) => a - b);
    const avgLatency = latencies.length > 0
      ? latencies.reduce((s, v) => s + v, 0) / latencies.length
      : 0;
    const avgTps = avgLatency > 0 ? (totalTokens / latencies.length) / (avgLatency / 1000) : 0;

    const cost = estimateCost(provider, modelId, totalTokens, 0);

    results.push({
      provider,
      model: modelId,
      latencyMs: latencies,
      p50Ms: percentile(latencies, 50),
      p99Ms: percentile(latencies, 99),
      avgTokensPerSecond: Math.round(avgTps),
      totalTokens,
      estimatedCostUsd: cost.totalCostUsd,
      error: errorMsg,
    });
  }

  return results.sort((a, b) => a.p50Ms - b.p50Ms);
}
