// ── Inference Warm-Up Probe ───────────────────────────────────────────
// Primes LLM provider connections before traffic opens.

import { createPrimaryInferenceClient } from "./factory-internal.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("warm-pool-probe");

export interface WarmUpResult {
  provider: string;
  model: string;
  latencyMs: number;
  success: boolean;
  error?: string;
  warmedAt: Date;
}

// Module-level cache of warm-up results
const _warmUpStatus = new Map<string, WarmUpResult>();

const PROBE_MESSAGE = [{ role: "user" as const, content: "ping" }];
const PROBE_MAX_TOKENS = 4;

export async function warmUpProvider(
  provider: string,
  modelId: string,
  endpoint?: string,
): Promise<WarmUpResult> {
  const key = `${provider}:${modelId}`;
  const start = Date.now();

  try {
    const client = createPrimaryInferenceClient(provider, modelId, endpoint);
    await client.chat({ messages: PROBE_MESSAGE, maxTokens: PROBE_MAX_TOKENS });
    const result: WarmUpResult = {
      provider,
      model: modelId,
      latencyMs: Date.now() - start,
      success: true,
      warmedAt: new Date(),
    };
    _warmUpStatus.set(key, result);
    logger.info(`Warm-up OK: ${key} in ${result.latencyMs}ms`);
    return result;
  } catch (err) {
    const result: WarmUpResult = {
      provider,
      model: modelId,
      latencyMs: Date.now() - start,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      warmedAt: new Date(),
    };
    _warmUpStatus.set(key, result);
    logger.warn(`Warm-up FAILED: ${key} — ${result.error}`);
    return result;
  }
}

export interface WarmUpConfig {
  providers: Array<{ provider: string; modelId: string; endpoint?: string }>;
  probe?: string;
}

export async function warmUpAll(config: WarmUpConfig): Promise<WarmUpResult[]> {
  return Promise.all(
    config.providers.map(({ provider, modelId, endpoint }) =>
      warmUpProvider(provider, modelId, endpoint),
    ),
  );
}

export function getWarmUpStatus(): Map<string, WarmUpResult> {
  return new Map(_warmUpStatus);
}

export function computeReadinessStatus(results: WarmUpResult[]): "ready" | "degraded" | "unavailable" {
  if (results.length === 0) return "unavailable";
  const ok = results.filter((r) => r.success).length;
  if (ok === results.length) return "ready";
  if (ok > 0) return "degraded";
  return "unavailable";
}
