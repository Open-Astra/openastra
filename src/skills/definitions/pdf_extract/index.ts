import { z } from "zod";
import { PDFParse } from "pdf-parse";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── PDF Extract Skill ─────────────────────────────────────────────
// Fetches a PDF from a URL and extracts its text content
// using the pdf-parse library.

const PdfExtractParams = z.object({
  url: z.string().url().describe("URL of the PDF file to extract text from"),
});

const pdfExtractSkill: SkillDefinition = {
  name: "pdf_extract",
  version: "1.0.0",

  manifest: {
    id: "pdf_extract",
    name: "PDF Extract",
    description: "Fetches a PDF from a URL and extracts its text content.",
    category: "search",
    tools: ["pdf_extract"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "pdf_extract",
      description: "Fetch a PDF from a URL and extract its text content. Returns the full text, page count, and metadata.",
      parameters: PdfExtractParams,

      async execute(params) {
        try {
          const response = await safeFetch(params.url, {
            headers: {
              "Accept": "application/pdf",
              "User-Agent": "Astra-Agent/1.0",
            },
            timeoutMs: 30_000,
          });

          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}` };
          }

          const arrayBuffer = await response.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);

          const parser = new PDFParse({ data });
          const textResult = await parser.getText();
          const infoResult = await parser.getInfo();

          return {
            url: params.url,
            pageCount: textResult.total,
            charCount: textResult.text.length,
            text: textResult.text,
            info: infoResult as unknown,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Failed to extract PDF: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "pdf_extract",
      instructions: "You can extract text from PDF files using the `pdf_extract` tool. Provide the URL of the PDF.",
    };
  },
};

export default pdfExtractSkill;
