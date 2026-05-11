import type { InferenceClient } from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("warm-pool");

interface PoolEntry {
  client: InferenceClient;
  provider: string;
  modelId: string;
}

class WarmPool {
  private pool: PoolEntry[] = [];
  private maxSize: number;

  constructor(size = 3) {
    this.maxSize = size;
  }

  add(provider: string, modelId: string, client: InferenceClient): void {
    // Remove oldest if at capacity
    if (this.pool.length >= this.maxSize) {
      this.pool.shift();
    }
    this.pool.push({ client, provider, modelId });
    log.info(`Warm pool: added ${provider}:${modelId} (pool size: ${this.pool.length})`);
  }

  get(provider: string, modelId: string): InferenceClient | null {
    const idx = this.pool.findIndex((e) => e.provider === provider && e.modelId === modelId);
    if (idx === -1) return null;
    // Remove from pool (consumed)
    const [entry] = this.pool.splice(idx, 1);
    return entry?.client ?? null;
  }

  poolSize(): number {
    return this.pool.length;
  }
}

export const warmPool = new WarmPool();

export async function prewarm(
  models: string[], // array of "provider:modelId"
  createClient: (provider: string, modelId: string) => InferenceClient,
): Promise<void> {
  for (const spec of models) {
    const [provider, modelId] = spec.split(":") as [string, string];
    if (!provider || !modelId) continue;
    try {
      const client = createClient(provider, modelId);
      warmPool.add(provider, modelId, client);
      log.info(`Pre-warmed ${provider}:${modelId}`);
    } catch (err) {
      log.error(`Failed to pre-warm ${provider}:${modelId}:`, err);
    }
  }
}
