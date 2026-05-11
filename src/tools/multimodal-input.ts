import { z } from "zod";
import { registerTool } from "./registry.js";

// ── multimodal_input ────────────────────────────────────────────────
// Unified multi-modal input handler. Accepts references to images,
// audio, PDFs, and video, then routes to the appropriate processing
// pipeline and returns structured output.

const MultimodalInputParams = z.object({
  inputs: z
    .array(
      z.object({
        type: z.enum(["image", "audio", "pdf", "video", "text"]).describe("Input modality"),
        source: z.string().describe("File path, URL, or raw text content"),
        instructions: z.string().optional().describe("Specific processing instructions for this input"),
      }),
    )
    .min(1)
    .max(10)
    .describe("Array of multi-modal inputs to process"),
  merge_strategy: z
    .enum(["concatenate", "summarize", "structured"])
    .default("structured")
    .describe("How to merge results from multiple inputs"),
});

registerTool({
  name: "multimodal_input",
  description:
    "Process multiple input modalities (images, audio, PDFs, video, text) in a single request. Routes each input to the appropriate processor and merges results.",
  parameters: MultimodalInputParams,

  async execute(params, ctx) {
    const results: Array<{
      index: number;
      type: string;
      source: string;
      content: string;
      metadata?: Record<string, unknown>;
      error?: string;
    }> = [];

    for (let i = 0; i < params.inputs.length; i++) {
      const input = params.inputs[i]!;

      try {
        switch (input.type) {
          case "image": {
            // Route to image description via model inference
            const { getTool } = await import("./registry.js");
            const imageTool = getTool("model_inference");
            if (imageTool) {
              const result = await imageTool.execute(
                {
                  prompt: input.instructions ?? "Describe this image in detail.",
                  image_url: input.source,
                  max_tokens: 1000,
                },
                ctx,
              );
              results.push({
                index: i,
                type: "image",
                source: input.source,
                content: typeof result === "object" && result !== null && "content" in result
                  ? String((result as Record<string, unknown>).content)
                  : JSON.stringify(result),
              });
            } else {
              results.push({
                index: i,
                type: "image",
                source: input.source,
                content: `[Image reference: ${input.source}]`,
                metadata: { note: "Image processing tool not available" },
              });
            }
            break;
          }

          case "audio": {
            results.push({
              index: i,
              type: "audio",
              source: input.source,
              content: `[Audio reference: ${input.source}]`,
              metadata: {
                instructions: input.instructions ?? "transcribe",
                note: "Route to speech_to_text skill for processing",
              },
            });
            break;
          }

          case "pdf": {
            const { getTool } = await import("./registry.js");
            const pdfTool = getTool("pdf_read");
            if (pdfTool) {
              const result = await pdfTool.execute(
                { file_path: input.source, max_pages: 20 },
                ctx,
              );
              results.push({
                index: i,
                type: "pdf",
                source: input.source,
                content: typeof result === "object" && result !== null && "text" in result
                  ? String((result as Record<string, unknown>).text)
                  : JSON.stringify(result),
              });
            } else {
              results.push({
                index: i,
                type: "pdf",
                source: input.source,
                content: `[PDF reference: ${input.source}]`,
              });
            }
            break;
          }

          case "video": {
            results.push({
              index: i,
              type: "video",
              source: input.source,
              content: `[Video reference: ${input.source}]`,
              metadata: {
                instructions: input.instructions ?? "extract key frames and metadata",
                note: "Route to video_metadata skill for processing",
              },
            });
            break;
          }

          case "text": {
            results.push({
              index: i,
              type: "text",
              source: input.source.slice(0, 50),
              content: input.source,
            });
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          index: i,
          type: input.type,
          source: input.source,
          content: "",
          error: message,
        });
      }
    }

    // Merge results
    let merged: string;
    switch (params.merge_strategy) {
      case "concatenate":
        merged = results.map((r) => r.content).join("\n\n---\n\n");
        break;
      case "summarize":
        merged = results
          .map((r) => `[${r.type.toUpperCase()}] ${r.content.slice(0, 500)}`)
          .join("\n\n");
        break;
      case "structured":
      default:
        merged = JSON.stringify(
          results.map((r) => ({
            type: r.type,
            content: r.content.slice(0, 2000),
            error: r.error,
          })),
          null,
          2,
        );
        break;
    }

    return {
      result: `Processed ${results.length} input(s)`,
      inputCount: results.length,
      errors: results.filter((r) => r.error).length,
      merged,
      details: results,
    };
  },
});
