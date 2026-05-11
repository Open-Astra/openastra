// ── Speculative Decoding / Race Mode ─────────────────────────────────
// Fire multiple providers in parallel and use whichever responds first.

import type { InferenceClient, InferenceRequest, InferenceResponse, InferenceStreamDelta } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("inference-race");

export interface RaceConfig {
  clients: Array<{ client: InferenceClient; label: string }>;
  timeoutMs?: number;
}

export interface RaceResult {
  response: InferenceResponse;
  winner: string;
  loserMs: Record<string, number>;
}

/**
 * Fire all clients in parallel and return the first successful response.
 * Slower clients are abandoned (their promises are ignored after the first resolves).
 */
export async function raceInference(
  request: InferenceRequest,
  config: RaceConfig,
): Promise<RaceResult> {
  const { clients, timeoutMs = 30_000 } = config;
  const startMs = Date.now();
  const startTimes = new Map<string, number>();

  const racePromises = clients.map(({ client, label }) => {
    startTimes.set(label, Date.now());
    return client
      .chat(request)
      .then((response): { response: InferenceResponse; label: string; latency: number } => ({
        response,
        label,
        latency: Date.now() - startTimes.get(label)!,
      }));
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Race timeout")), timeoutMs),
  );

  const winner = await Promise.race([Promise.any(racePromises), timeoutPromise]);

  const loserMs: Record<string, number> = {};
  for (const { label } of clients) {
    if (label !== winner.label) {
      loserMs[label] = Date.now() - startMs;
    }
  }

  logger.info(`Race won by ${winner.label} in ${winner.latency}ms`);

  return {
    response: winner.response,
    winner: winner.label,
    loserMs,
  };
}

/**
 * Streaming race: start all providers, yield deltas from the first one
 * that produces a chunk, then drain only that winner.
 */
export async function* raceInferenceStream(
  request: InferenceRequest,
  config: RaceConfig,
): AsyncGenerator<InferenceStreamDelta & { winner?: string }> {
  const { clients, timeoutMs = 30_000 } = config;

  type StreamEntry = {
    label: string;
    iter: AsyncIterator<InferenceStreamDelta>;
    firstChunk: InferenceStreamDelta;
  };

  // Start all iterators
  const iterators = clients.map(({ client, label }) => ({
    label,
    iter: client.chatStream(request)[Symbol.asyncIterator](),
  }));

  // Race to first chunk
  const firstChunkPromises = iterators.map(async ({ label, iter }) => {
    const result = await iter.next();
    if (result.done) throw new Error(`${label} stream ended immediately`);
    return { label, iter, firstChunk: result.value } as StreamEntry;
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Stream race timeout")), timeoutMs),
  );

  let winner: StreamEntry;
  try {
    winner = await Promise.race([Promise.any(firstChunkPromises), timeoutPromise]);
  } catch {
    throw new Error("All providers failed to produce a stream chunk");
  }

  // Yield winning provider's chunks
  yield { ...winner.firstChunk, winner: winner.label };

  let next = await winner.iter.next();
  while (!next.done) {
    yield next.value;
    next = await winner.iter.next();
  }
}
