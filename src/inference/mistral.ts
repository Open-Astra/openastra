// ── Mistral Provider ─────────────────────────────────────────────────
// Mistral AI exposes an OpenAI-compatible API at api.mistral.ai.
// Models: mistral-large-latest, mistral-small-latest, open-mistral-7b, etc.

import type { InferenceClient } from "./types.js";
import { createOpenAIClient } from "./openai.js";

export function createMistralClient(apiKey: string, modelId: string): InferenceClient {
  return createOpenAIClient(
    apiKey,
    modelId,
    "https://api.mistral.ai/v1",
  );
}
