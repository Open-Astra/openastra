import { z } from "zod";
import { registerTool } from "./registry.js";

// ── image_generate ────────────────────────────────────────────────────
// DALL-E 3 image generation via the OpenAI API.

const ImageGenerateParams = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe("Text description of the image to generate"),
  size: z
    .enum(["1024x1024", "1792x1024", "1024x1792"])
    .default("1024x1024")
    .describe("Image dimensions (default 1024x1024)"),
  quality: z
    .enum(["standard", "hd"])
    .default("standard")
    .describe("Image quality — 'hd' produces finer details (default standard)"),
  style: z
    .enum(["vivid", "natural"])
    .default("vivid")
    .describe("Image style — 'vivid' for dramatic, 'natural' for realistic (default vivid)"),
});

registerTool({
  name: "image_generate",
  description:
    "Generate an image using DALL-E 3 via the OpenAI API. Provide a text prompt and receive a URL to the generated image. Requires OPENAI_API_KEY. Supports different sizes, quality levels, and styles.",
  parameters: ImageGenerateParams,
  async execute(params) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { error: "OPENAI_API_KEY is required for image generation." };
    }

    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: params.prompt,
          n: 1,
          size: params.size,
          quality: params.quality,
          style: params.style,
          response_format: "url",
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        return { error: `OpenAI API error (${res.status}): ${body}` };
      }

      const data = (await res.json()) as {
        data: Array<{
          url?: string;
          revised_prompt?: string;
        }>;
      };

      const image = data.data[0];
      if (!image?.url) {
        return { error: "No image URL returned from OpenAI." };
      }

      return {
        url: image.url,
        revisedPrompt: image.revised_prompt ?? params.prompt,
        size: params.size,
        quality: params.quality,
        style: params.style,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
