import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Embed Text Skill ──────────────────────────────────────────────
// Placeholder for text embedding. Returns a deterministic mock
// embedding vector. In production, would call an embedding API
// (e.g. OpenAI text-embedding-ada-002, Cohere embed, etc.).

const EMBEDDING_DIMENSIONS = 128;

function mockEmbedding(text: string): number[] {
  // Generate a deterministic pseudo-embedding based on character codes
  const vector: number[] = [];
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const charCode = text.charCodeAt(i % text.length) || 0;
    // Normalize to roughly [-1, 1] range
    vector.push(Math.sin(charCode * (i + 1) * 0.1));
  }

  // L2-normalize the vector
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / magnitude;
    }
  }

  return vector;
}

const EmbedTextParams = z.object({
  text: z.string().describe("Text to generate an embedding for"),
});

const embedTextSkill: SkillDefinition = {
  name: "embed_text",
  version: "1.0.0",

  manifest: {
    id: "embed_text",
    name: "Embed Text",
    description: "Generates a vector embedding for input text. Currently returns a mock embedding — requires an embedding API in production.",
    category: "analyze",
    tools: ["embed_text"],
    configFields: [
      {
        name: "embeddingApiKey",
        type: "string",
        required: false,
        description: "API key for embedding service (e.g. OpenAI)",
        envVar: "EMBEDDING_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "embed_text",
      description: "Generate a vector embedding for text. Currently returns a deterministic mock embedding. Configure an embedding API for production use.",
      parameters: EmbedTextParams,

      async execute(params) {
        const embedding = mockEmbedding(params.text);

        return {
          text: params.text.slice(0, 100) + (params.text.length > 100 ? "..." : ""),
          dimensions: EMBEDDING_DIMENSIONS,
          embedding,
          note: "This is a mock embedding. Configure an embedding API (OpenAI, Cohere, etc.) for production-quality vectors.",
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "embed_text",
      instructions: "You can generate text embeddings using the `embed_text` tool. Note: currently returns mock embeddings. An embedding API is needed for production use.",
    };
  },
};

export default embedTextSkill;
