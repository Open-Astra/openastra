import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── OCR Skill ────────────────────────────────────────────────────
// Extracts text from images using a vision-capable LLM.
// Supports OpenAI GPT-4 Vision or Google Gemini.

const OcrParams = z.object({
  imageUrl: z.string().url().describe("URL of the image to extract text from"),
  prompt: z
    .string()
    .default("Extract all text from this image. Preserve formatting where possible.")
    .describe("Custom prompt for the vision model (default: extract all text)"),
});

async function ocrWithOpenAI(
  imageUrl: string,
  prompt: string,
  apiKey: string,
): Promise<{ text: string } | { error: string }> {
  const response = await safeFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "high" },
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
    return { error: `OpenAI Vision API returned ${response.status}: ${body}` };
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = result.choices?.[0]?.message?.content ?? "";
  return { text };
}

async function ocrWithGemini(
  imageUrl: string,
  prompt: string,
  apiKey: string,
): Promise<{ text: string } | { error: string }> {
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

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { text };
}

const ocrSkill: SkillDefinition = {
  name: "ocr",
  version: "1.0.0",

  manifest: {
    id: "ocr",
    name: "OCR",
    description:
      "Extracts text from images using a vision-capable LLM (OpenAI GPT-4 Vision or Google Gemini). Falls back gracefully if no API key is available.",
    category: "transform",
    tools: ["ocr"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "ocr",
      description:
        "Extract text from an image using a vision-capable AI model. Provide the image URL and optionally a custom prompt. Uses OpenAI or Gemini based on available API keys.",
      parameters: OcrParams,

      async execute(params) {
        const openaiKey = process.env.OPENAI_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY;

        if (!openaiKey && !geminiKey) {
          return {
            error:
              "OCR requires a vision-capable API key. Set OPENAI_API_KEY or GEMINI_API_KEY environment variable.",
          };
        }

        try {
          // Prefer OpenAI, fall back to Gemini
          let result: { text: string } | { error: string };

          if (openaiKey) {
            result = await ocrWithOpenAI(params.imageUrl, params.prompt, openaiKey);
            // If OpenAI fails and Gemini is available, try Gemini
            if ("error" in result && geminiKey) {
              result = await ocrWithGemini(params.imageUrl, params.prompt, geminiKey);
            }
          } else {
            result = await ocrWithGemini(params.imageUrl, params.prompt, geminiKey!);
          }

          if ("error" in result) {
            return result;
          }

          return {
            imageUrl: params.imageUrl,
            prompt: params.prompt,
            extractedText: result.text,
            characterCount: result.text.length,
            provider: openaiKey ? "openai" : "gemini",
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `OCR failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "ocr",
      instructions:
        "You can extract text from images using the `ocr` tool. Provide an image URL and optionally a custom prompt. Requires OPENAI_API_KEY or GEMINI_API_KEY.",
    };
  },
};

export default ocrSkill;
