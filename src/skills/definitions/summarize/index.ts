import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Summarize Skill ───────────────────────────────────────────────
// Produces a truncated summary of text. This is a simple substring
// implementation — in production, would delegate to an LLM.

const SummarizeParams = z.object({
  text: z.string().describe("Text to summarize"),
  maxLength: z.number().int().min(20).max(5000).default(200).describe("Maximum length of the summary (default 200)"),
});

const summarizeSkill: SkillDefinition = {
  name: "summarize",
  version: "1.0.0",

  manifest: {
    id: "summarize",
    name: "Summarize",
    description: "Produces a truncated summary of input text. Simple substring extraction for now.",
    category: "transform",
    tools: ["summarize"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "summarize",
      description: "Summarize text by extracting the leading portion up to the specified max length.",
      parameters: SummarizeParams,

      async execute(params) {
        const { text, maxLength } = params;

        if (text.length <= maxLength) {
          return {
            summary: text,
            originalLength: text.length,
            truncated: false,
          };
        }

        // Find the last space before maxLength to avoid cutting mid-word
        let cutoff = text.lastIndexOf(" ", maxLength);
        if (cutoff <= 0) {
          cutoff = maxLength;
        }

        const summary = text.slice(0, cutoff) + "...";

        return {
          summary,
          originalLength: text.length,
          truncated: true,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "summarize",
      instructions: "You can summarize text using the `summarize` tool. It truncates text to a specified max length.",
    };
  },
};

export default summarizeSkill;
