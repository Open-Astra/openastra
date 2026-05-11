import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateLocalEmbedding, generateLocalEmbeddings } from "./local-embeddings.js";
import { generateOllamaEmbedding, generateOllamaEmbeddings } from "../inference/ollama.js";
import { createLogger } from "../utils/logger.js";
import { getCachedEmbedding, setCachedEmbedding } from "./embedding-cache.js";

// ── Embedding Service ───────────────────────────────────────────────
// Supports three providers with automatic failover:
//   "gemini" — Google's gemini-embedding-001 (768-dim, best quality)
//   "openai" — OpenAI text-embedding-3-small (768-dim via dimensions param)
//   "ollama" — Local models via Ollama (e.g. nomic-embed-text, 768-dim)
//   "local"  — Character n-gram hash projection (768-dim, zero deps)
//
// Failover chain (when primary fails):
//   gemini → openai → local
//   openai → local
//   ollama → local
//
// Providers with >3 consecutive failures are skipped for 5 minutes.

const log = createLogger("embeddings");
const EMBEDDING_DIM = 768;

let genai: GoogleGenerativeAI | undefined;
let ollamaModel: string | undefined;
let provider: "gemini" | "ollama" | "local" = "local";

// ── Failover Tracking ───────────────────────────────────────────────

interface FailoverState {
  consecutiveFailures: number;
  backoffUntil: number; // timestamp
}

const failoverStates = new Map<string, FailoverState>();
const FAILURE_THRESHOLD = 3;
const BACKOFF_MS = 5 * 60_000; // 5 minutes

function recordFailure(providerName: string): void {
  const state = failoverStates.get(providerName) ?? { consecutiveFailures: 0, backoffUntil: 0 };
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    state.backoffUntil = Date.now() + BACKOFF_MS;
    log.warn(`Embedding provider "${providerName}" backed off for 5 minutes after ${state.consecutiveFailures} consecutive failures`);
  }
  failoverStates.set(providerName, state);
}

function recordSuccess(providerName: string): void {
  const state = failoverStates.get(providerName);
  if (state) {
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
  }
}

function isProviderAvailable(providerName: string): boolean {
  const state = failoverStates.get(providerName);
  if (!state) return true;
  if (state.consecutiveFailures < FAILURE_THRESHOLD) return true;
  return Date.now() >= state.backoffUntil;
}

// ── OpenAI Embedding Helpers ────────────────────────────────────────

async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

async function generateOpenAIEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
  // Sort by index to preserve order
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export function initEmbeddings(apiKey?: string): void {
  const envProvider = process.env.EMBEDDING_PROVIDER;

  if (envProvider === "local") {
    provider = "local";
    log.active("Embeddings", "local (n-gram hash projection)");
    return;
  }

  if (envProvider === "ollama") {
    provider = "ollama";
    ollamaModel = process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text";
    log.active("Embeddings", `Ollama ${ollamaModel}`);
    return;
  }

  if (apiKey) {
    genai = new GoogleGenerativeAI(apiKey);
    provider = "gemini";
    log.active("Embeddings", "Gemini gemini-embedding-001");
  } else {
    provider = "local";
    log.active("Embeddings", "local (no Gemini API key)");
  }
}

export function getEmbeddingProvider(): "gemini" | "ollama" | "local" {
  return provider;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  // Check cache first
  const cached = await getCachedEmbedding(text);
  if (cached) return cached;

  let result: number[];

  if (provider === "local") {
    result = generateLocalEmbedding(text);
    setCachedEmbedding(text, result).catch(() => {});
    return result;
  }

  if (provider === "ollama") {
    try {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      result = await generateOllamaEmbedding(text, ollamaModel ?? "nomic-embed-text", baseUrl);
      recordSuccess("ollama");
    } catch (err) {
      log.warn("Ollama embedding failed, falling back to local:", err instanceof Error ? err.message : String(err));
      recordFailure("ollama");
      result = generateLocalEmbedding(text);
    }
    setCachedEmbedding(text, result).catch(() => {});
    return result;
  }

  // Gemini primary with failover chain: gemini → openai → local
  if (!genai) throw new Error("Gemini embeddings not initialized — call initEmbeddings()");

  // Try Gemini first (if not backed off)
  if (isProviderAvailable("gemini")) {
    try {
      const model = genai.getGenerativeModel({ model: "gemini-embedding-001" });
      const req = { content: { parts: [{ text }], role: "user" }, outputDimensionality: EMBEDDING_DIM };
      const embedResult = await model.embedContent(req);
      result = embedResult.embedding.values;
      recordSuccess("gemini");
      setCachedEmbedding(text, result).catch(() => {});
      return result;
    } catch (err) {
      log.warn("Gemini embedding failed:", err instanceof Error ? err.message : String(err));
      recordFailure("gemini");
    }
  }

  // Failover to OpenAI (if key available and not backed off)
  if (process.env.OPENAI_API_KEY && isProviderAvailable("openai-embedding")) {
    try {
      result = await generateOpenAIEmbedding(text);
      recordSuccess("openai-embedding");
      log.dim("Embedding failover: using OpenAI");
      setCachedEmbedding(text, result).catch(() => {});
      return result;
    } catch (err) {
      log.warn("OpenAI embedding failover failed:", err instanceof Error ? err.message : String(err));
      recordFailure("openai-embedding");
    }
  }

  // Final fallback: local
  log.warn("All embedding providers failed, using local fallback");
  result = generateLocalEmbedding(text);
  setCachedEmbedding(text, result).catch(() => {});
  return result;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // Check cache for each text; only call provider for misses
  const results: (number[] | null)[] = await Promise.all(
    texts.map((t) => getCachedEmbedding(t)),
  );

  const missIndexes = texts.reduce<number[]>((acc, _, i) => {
    if (results[i] === null) acc.push(i);
    return acc;
  }, []);

  if (missIndexes.length === 0) {
    return results as number[][];
  }

  const missTexts = missIndexes.map((i) => texts[i]);
  let fetched: number[][];

  if (provider === "local") {
    fetched = generateLocalEmbeddings(missTexts);
  } else if (provider === "ollama") {
    try {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      fetched = await generateOllamaEmbeddings(missTexts, ollamaModel ?? "nomic-embed-text", baseUrl);
      recordSuccess("ollama");
    } catch (err) {
      log.warn("Ollama batch embedding failed, falling back to local:", err instanceof Error ? err.message : String(err));
      recordFailure("ollama");
      fetched = generateLocalEmbeddings(missTexts);
    }
  } else {
    if (!genai) throw new Error("Gemini embeddings not initialized — call initEmbeddings()");

    // Gemini with failover chain: gemini → openai → local
    fetched = null as unknown as number[][];

    if (isProviderAvailable("gemini")) {
      try {
        const model = genai.getGenerativeModel({ model: "gemini-embedding-001" });
        const requests = missTexts.map((text) => ({
          content: { parts: [{ text }], role: "user" },
          outputDimensionality: EMBEDDING_DIM,
        }));
        const batchResult = await model.batchEmbedContents({ requests });
        fetched = batchResult.embeddings.map((e: { values: number[] }) => e.values);
        recordSuccess("gemini");
      } catch (err) {
        log.warn("Gemini batch embedding failed:", err instanceof Error ? err.message : String(err));
        recordFailure("gemini");
      }
    }

    // Failover to OpenAI batch
    if (!fetched && process.env.OPENAI_API_KEY && isProviderAvailable("openai-embedding")) {
      try {
        fetched = await generateOpenAIEmbeddings(missTexts);
        recordSuccess("openai-embedding");
        log.dim("Batch embedding failover: using OpenAI");
      } catch (err) {
        log.warn("OpenAI batch embedding failover failed:", err instanceof Error ? err.message : String(err));
        recordFailure("openai-embedding");
      }
    }

    // Final fallback: local
    if (!fetched) {
      log.warn("All batch embedding providers failed, using local fallback");
      fetched = generateLocalEmbeddings(missTexts);
    }
  }

  // Fill in results and cache
  for (let i = 0; i < missIndexes.length; i++) {
    const originalIndex = missIndexes[i];
    results[originalIndex] = fetched[i];
    setCachedEmbedding(texts[originalIndex], fetched[i]).catch(() => {});
  }

  return results as number[][];
}
