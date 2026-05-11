// ── Workspace Knowledge Tools ───────────────────────────────────────
// Two tools for creating and searching structured knowledge entries
// (ADRs, standards, runbooks, FAQs, glossary). Both require
// workspaceId in the tool context — returns an error if missing.

import { z } from "zod";
import { registerTool } from "./registry.js";
import { createKnowledgeEntry, searchKnowledge } from "../memory/workspace-knowledge.js";

// ── workspace_knowledge_write ──────────────────────────────────────

const WriteParams = z.object({
  type: z
    .enum(["adr", "standard", "runbook", "faq", "glossary"])
    .describe("Type of knowledge entry"),
  title: z.string().describe("Title of the knowledge entry"),
  content: z.string().describe("Full content of the knowledge entry"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags for categorization"),
});

registerTool({
  name: "workspace_knowledge_write",
  description:
    "Create a structured knowledge entry in the workspace knowledge base. Use for ADRs (architecture decision records), coding standards, operational runbooks, FAQs, and glossary definitions that the team should reference.",
  parameters: WriteParams,

  async execute(params, ctx) {
    if (!ctx.workspaceId) {
      return { error: "No workspace context. This tool requires a workspace to be active." };
    }

    const result = await createKnowledgeEntry({
      workspaceId: ctx.workspaceId,
      authorId: ctx.uid,
      type: params.type,
      title: params.title,
      content: params.content,
      tags: params.tags,
    });

    return {
      success: true,
      id: result.id,
      message: `Knowledge entry created: [${params.type}] ${params.title}`,
    };
  },
});

// ── workspace_knowledge_search ─────────────────────────────────────

const SearchParams = z.object({
  query: z.string().describe("Natural language search query for the knowledge base"),
  type: z
    .enum(["adr", "standard", "runbook", "faq", "glossary"])
    .optional()
    .describe("Filter by knowledge type"),
  status: z
    .enum(["active", "deprecated", "superseded"])
    .optional()
    .describe("Filter by entry status"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of results to return"),
});

registerTool({
  name: "workspace_knowledge_search",
  description:
    "Search the workspace knowledge base for standards, ADRs, runbooks, FAQs, and glossary entries. Uses semantic vector search for accurate retrieval across all structured knowledge.",
  parameters: SearchParams,

  async execute(params, ctx) {
    if (!ctx.workspaceId) {
      return { error: "No workspace context. This tool requires a workspace to be active." };
    }

    const results = await searchKnowledge({
      workspaceId: ctx.workspaceId,
      query: params.query,
      type: params.type,
      status: params.status,
      limit: params.limit,
    });

    if (results.length === 0) {
      return {
        results: [],
        message: "No relevant knowledge entries found.",
      };
    }

    return {
      results: results.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        status: r.status,
        relevance: r.score,
      })),
      message: `Found ${results.length} relevant knowledge entries.`,
    };
  },
});
