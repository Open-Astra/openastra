// ── Edge / Hardware Accelerator Provider ─────────────────────────────
// Routes inference to a local vLLM instance via its OpenAI-compatible
// /v1/chat/completions endpoint. Adds X-Edge-Backend: vllm to all
// outbound requests. Falls back through the resilient layer on ECONNREFUSED.
//
// Required env var:
//   EDGE_INFERENCE_URL  — default: http://localhost:8000
//
// The "edge" provider is intended for local GPU / hardware accelerator
// deployments where latency matters more than reliability guarantees.

import type {
  InferenceClient,
  InferenceRequest,
  InferenceResponse,
  InferenceStreamDelta,
} from "./types.js";
import { createOpenAIClient } from "./openai.js";

const DEFAULT_EDGE_URL = "http://localhost:8000";

export function createEdgeClient(modelId: string, baseUrl?: string): InferenceClient {
  const url = (baseUrl ?? process.env.EDGE_INFERENCE_URL ?? DEFAULT_EDGE_URL).replace(/\/$/, "");

  const inner = createOpenAIClient(
    "no-key", // vLLM ignores API keys on localhost
    modelId,
    `${url}/v1`,
    {
      "X-Edge-Backend": "vllm",
    },
  );

  async function wrapChat(request: InferenceRequest): Promise<InferenceResponse> {
    try {
      return await inner.chat(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        // Surface the error clearly so the resilient layer can fall back
        throw new Error(`[edge] ECONNREFUSED — edge host unreachable at ${url}: ${msg}`);
      }
      throw err;
    }
  }

  async function* wrapStream(request: InferenceRequest): AsyncIterable<InferenceStreamDelta> {
    try {
      yield* inner.chatStream(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        throw new Error(`[edge] ECONNREFUSED — edge host unreachable at ${url}: ${msg}`);
      }
      throw err;
    }
  }

  return {
    chat: wrapChat,
    chatStream: wrapStream,
  };
}
