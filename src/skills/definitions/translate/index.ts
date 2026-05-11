import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Translate Skill ───────────────────────────────────────────────
// Placeholder translation skill. Returns a stub indicating that
// actual translation requires an external API integration.

const TranslateParams = z.object({
  text: z.string().describe("Text to translate"),
  targetLanguage: z.string().describe("Target language code or name (e.g. 'es', 'French')"),
  sourceLanguage: z.string().optional().describe("Source language code or name (auto-detected if omitted)"),
});

const translateSkill: SkillDefinition = {
  name: "translate",
  version: "1.0.0",

  manifest: {
    id: "translate",
    name: "Translate",
    description: "Translates text between languages. Currently a placeholder — requires external translation API in production.",
    category: "transform",
    tools: ["translate"],
    configFields: [
      {
        name: "translationApiKey",
        type: "string",
        required: false,
        description: "API key for translation service (e.g. Google Translate, DeepL)",
        envVar: "TRANSLATION_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "translate",
      description: "Translate text from one language to another. Currently returns a placeholder — integration with a translation API is required for actual translations.",
      parameters: TranslateParams,

      async execute(params) {
        const { text, targetLanguage, sourceLanguage } = params;

        return {
          originalText: text,
          sourceLanguage: sourceLanguage ?? "auto-detected",
          targetLanguage,
          translatedText: `[Translation to ${targetLanguage} not available — external API integration required]`,
          note: "This is a placeholder. Configure a translation API (Google Translate, DeepL, etc.) for actual translations.",
          charCount: text.length,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "translate",
      instructions: "You can request translations using the `translate` tool. Note: actual translation requires an external API to be configured.",
    };
  },
};

export default translateSkill;
