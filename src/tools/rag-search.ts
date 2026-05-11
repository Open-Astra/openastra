import { z } from "zod";
import { registerTool } from "./registry.js";
import { searchDocuments, listDocuments } from "../memory/rag.js";

// ── rag_search ───────────────────────────────────────────────────────
// Searches user-uploaded documents (PDFs, Markdown, Obsidian, etc.)
// using vector similarity via pgvector embeddings.

const RagSearchParams = z.object({
  action: z
    .enum(["search", "list"])
    .describe("Action: search documents by query or list uploaded docs"),
  query: z
    .string()
    .optional()
    .describe("Search query (required for search action)"),
  limit: z
    .number()
    .optional()
    .default(5)
    .describe("Max results to return (default: 5)"),
});

registerTool({
  name: "rag_search",
  description:
    "Search through user-uploaded documents (PDFs, Markdown, Obsidian notes). Uses vector similarity to find relevant passages.",
  parameters: RagSearchParams,

  async execute(params, ctx) {
    if (params.action === "list") {
      const docs = await listDocuments(ctx.uid);
      if (docs.length === 0) {
        return { result: "No documents uploaded." };
      }
      return {
        result: `${docs.length} document(s)`,
        documents: docs.map((d) => ({
          id: d.id,
          filename: d.title,
          type: d.format,
          createdAt: d.createdAt,
        })),
      };
    }

    if (!params.query) {
      return { error: "query is required for search action" };
    }

    const results = await searchDocuments(ctx.uid, params.query, params.limit);
    if (results.length === 0) {
      return { result: "No matching document passages found." };
    }

    return {
      result: `Found ${results.length} relevant passage(s)`,
      passages: results.map((r) => ({
        content: r.chunk.content,
        documentId: r.chunk.documentId,
        similarity: r.score,
      })),
    };
  },
});
