import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Image Generation Skill ──────────────────────────────────────────
// Generate images via OpenAI DALL-E or compatible API.
// Requires IMAGE_GEN_API_KEY (OpenAI key) or IMAGE_GEN_API_URL.

const GenerateParams = z.object({
  prompt: z.string().max(1000).describe("Image description/prompt"),
  size: z.enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"]).default("1024x1024"),
  quality: z.enum(["standard", "hd"]).default("standard"),
  style: z.enum(["vivid", "natural"]).default("vivid"),
  n: z.number().int().min(1).max(4).default(1).describe("Number of images to generate"),
});

const EditParams = z.object({
  prompt: z.string().max(1000).describe("Description of the edit to make"),
  imageUrl: z.string().url().describe("URL of the source image"),
});

const imageGenerateSkill: SkillDefinition = {
  name: "image_generate",
  version: "1.0.0",

  manifest: {
    id: "image_generate",
    name: "Image Generation",
    description: "Generate images from text prompts using DALL-E or compatible AI image generation APIs.",
    category: "execute",
    tools: ["image_generate", "image_edit"],
    configFields: [
      { name: "apiKey", type: "string", required: true, description: "OpenAI API key", envVar: "IMAGE_GEN_API_KEY" },
      { name: "apiUrl", type: "string", required: false, description: "Custom API URL", envVar: "IMAGE_GEN_API_URL" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      apiKey: process.env.IMAGE_GEN_API_KEY ?? "",
      apiUrl: process.env.IMAGE_GEN_API_URL ?? "https://api.openai.com/v1",
    });

    ctx.registerTool({
      name: "image_generate",
      description: "Generate an image from a text prompt. Returns image URLs.",
      parameters: GenerateParams,

      async execute(params) {
        const { apiKey, apiUrl } = getConfig();
        if (!apiKey) return { error: "IMAGE_GEN_API_KEY not configured." };

        const res = await safeFetch(`${apiUrl}/images/generations`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: params.prompt,
            size: params.size,
            quality: params.quality,
            style: params.style,
            n: params.n,
          }),
          timeoutMs: 60_000,
          ssrfProtection: false,
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Image API error ${res.status}: ${err.slice(0, 300)}` };
        }

        const data = (await res.json()) as { data: Array<{ url: string; revised_prompt?: string }> };
        return {
          prompt: params.prompt,
          count: data.data.length,
          images: data.data.map((img) => ({
            url: img.url,
            revisedPrompt: img.revised_prompt,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "image_edit",
      description: "Edit/modify an existing image based on a text prompt.",
      parameters: EditParams,

      async execute(params) {
        const { apiKey, apiUrl } = getConfig();
        if (!apiKey) return { error: "IMAGE_GEN_API_KEY not configured." };

        // For image editing, we describe the edit in the prompt
        const res = await safeFetch(`${apiUrl}/images/generations`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: `Edit the following image: ${params.imageUrl}\n\nEdit instructions: ${params.prompt}`,
            size: "1024x1024",
            n: 1,
          }),
          timeoutMs: 60_000,
          ssrfProtection: false,
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Image API error ${res.status}: ${err.slice(0, 300)}` };
        }

        const data = (await res.json()) as { data: Array<{ url: string; revised_prompt?: string }> };
        return {
          prompt: params.prompt,
          sourceImage: params.imageUrl,
          result: data.data[0],
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "image_generate",
      instructions: "You can generate images with `image_generate` (text-to-image) and `image_edit` (modify existing images). Uses DALL-E 3. Requires IMAGE_GEN_API_KEY.",
    };
  },
};

export default imageGenerateSkill;
