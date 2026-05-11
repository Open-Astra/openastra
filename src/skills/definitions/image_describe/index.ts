import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Image Describe Skill ──────────────────────────────────────────
// Describes image content using a vision-capable LLM.
// Supports OpenAI GPT-4o, Google Gemini, or any OpenAI-compatible
// vision endpoint (vLLM serving Llama 4 Scout/Maverick, Groq, etc.).

const ImageDescribeParams = z.object({
  imageUrl: z.string().url().describe("URL of the image to describe"),
  prompt: z
    .string()
    .default("Describe this image in detail. Include relevant objects, text, colors, layout, and any notable features.")
    .describe("Custom prompt for the vision model"),
});

async function describeWithOpenAICompat(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ description: string; provider: string } | { error: string }> {
  const response = await safeFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "auto" },
            },
          ],
        },
      ],
      max_tokens: 4096,
    }),
    timeoutMs: 60_000,
    ssrfProtection: false,
  });

  if (!response.ok) {
    const body = await response.text();
    return { error: `Vision API returned ${response.status}: ${body}` };
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const description = result.choices?.[0]?.message?.content ?? "";
  return { description, provider: `${baseUrl}/${model}` };
}

async function describeWithGemini(
  imageUrl: string,
  prompt: string,
  apiKey: string,
): Promise<{ description: string; provider: string } | { error: string }> {
  // Fetch the image and convert to base64
  const imageResponse = await safeFetch(imageUrl, { timeoutMs: 30_000 });
  if (!imageResponse.ok) {
    return { error: `Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}` };
  }

  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString("base64");
  const mimeType = imageResponse.headers.get("content-type") ?? "image/jpeg";

  const response = await safeFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
      }),
      timeoutMs: 60_000,
      ssrfProtection: false,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    return { error: `Gemini Vision API returned ${response.status}: ${body}` };
  }

  const result = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const description = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { description, provider: "gemini-2.0-flash" };
}

const imageDescribeSkill: SkillDefinition = {
  name: "image_describe",
  version: "2.0.0",

  manifest: {
    id: "image_describe",
    name: "Image Describe",
    description: "Describes image content using a vision-capable LLM. Supports OpenAI, Gemini, or any OpenAI-compatible vision endpoint (vLLM with Llama 4, Groq, etc.).",
    category: "analyze",
    tools: ["image_describe"],
    configFields: [
      {
        name: "visionEndpoint",
        type: "string",
        required: false,
        description: "OpenAI-compatible vision endpoint URL (e.g. http://localhost:8000/v1 for vLLM with Llama 4)",
        envVar: "VISION_ENDPOINT",
      },
      {
        name: "visionModel",
        type: "string",
        required: false,
        description: "Model ID for the vision endpoint (e.g. meta-llama/llama-4-scout-17b-16e-instruct)",
        envVar: "VISION_MODEL",
      },
      {
        name: "visionApiKey",
        type: "string",
        required: false,
        description: "API key for vision service (falls back to OPENAI_API_KEY or GEMINI_API_KEY)",
        envVar: "VISION_API_KEY",
      },
    ],
    version: "2.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "image_describe",
      description: "Describe the content of an image from its URL using a vision-capable AI model. Supports OpenAI, Gemini, or self-hosted vision models (Llama 4 Scout/Maverick via vLLM).",
      parameters: ImageDescribeParams,

      async execute(params) {
        // Priority: custom vision endpoint > OpenAI > Gemini
        const visionEndpoint = process.env.VISION_ENDPOINT;
        const visionModel = process.env.VISION_MODEL;
        const visionApiKey = process.env.VISION_API_KEY;
        const openaiKey = process.env.OPENAI_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY;

        try {
          let result: { description: string; provider: string } | { error: string };

          if (visionEndpoint && visionModel) {
            // Use custom vision endpoint (vLLM with Llama 4, Groq, etc.)
            result = await describeWithOpenAICompat(
              params.imageUrl,
              params.prompt,
              visionApiKey ?? openaiKey ?? "no-key",
              visionEndpoint,
              visionModel,
            );
          } else if (openaiKey) {
            // Use OpenAI GPT-4o
            result = await describeWithOpenAICompat(
              params.imageUrl,
              params.prompt,
              openaiKey,
              "https://api.openai.com/v1",
              "gpt-4o-mini",
            );
            // Fall back to Gemini if OpenAI fails
            if ("error" in result && geminiKey) {
              result = await describeWithGemini(params.imageUrl, params.prompt, geminiKey);
            }
          } else if (geminiKey) {
            result = await describeWithGemini(params.imageUrl, params.prompt, geminiKey);
          } else {
            return {
              imageUrl: params.imageUrl,
              description: "[No vision API available]",
              error: "Set VISION_ENDPOINT+VISION_MODEL, OPENAI_API_KEY, or GEMINI_API_KEY for image description.",
            };
          }

          if ("error" in result) {
            return { imageUrl: params.imageUrl, error: result.error };
          }

          return {
            imageUrl: params.imageUrl,
            description: result.description,
            provider: result.provider,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { imageUrl: params.imageUrl, error: `Image description failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "image_describe",
      instructions: "You can describe images using the `image_describe` tool. Provide an image URL and optionally a custom prompt. Supports OpenAI, Gemini, or self-hosted vision models (Llama 4 Scout/Maverick via vLLM).",
    };
  },
};

export default imageDescribeSkill;
