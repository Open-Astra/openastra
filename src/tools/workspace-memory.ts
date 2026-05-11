// ── Workspace Memory Tools ──────────────────────────────────────────
// Two tools for writing and searching team-scoped memory. Both require
// workspaceId in the tool context — returns an error if missing.

import { z } from "zod";
import { registerTool } from "./registry.js";
import { writeWorkspaceMemory, searchWorkspaceMemory } from "../memory/workspace-memory.js";

// ── workspace_memory_write ─────────────────────────────────────────

const WriteParams = z.object({
  category: z
    .enum(["decision", "adr", "standup", "retrospective", "note", "knowledge"])
    .describe("Category of the workspace memory entry"),
  content: z.string().describe("The memory content to persist for the team"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags for filtering and organization"),
});

registerTool({
  name: "workspace_memory_write",
  description:
    "Save important team information to workspace memory. Use this for team decisions, architecture decision records (ADRs), standup notes, retrospectives, and shared knowledge that all team members should access.",
  parameters: WriteParams,

  async execute(params, ctx) {
    if (!ctx.workspaceId) {
      return { error: "No workspace context. This tool requires a workspace to be active." };
    }

    const result = await writeWorkspaceMemory({
      workspaceId: ctx.workspaceId,
      authorId: ctx.uid,
      category: params.category,
      content: params.content,
      tags: params.tags,
    });

    return {
      success: true,
      id: result.id,
      message: `Workspace memory saved: [${params.category}] ${params.content.slice(0, 100)}${params.content.length > 100 ? "..." : ""}`,
    };
  },
});

// ── workspace_memory_search ────────────────────────────────────────

const SearchParams = z.object({
  query: z.string().describe("Natural language search query for workspace memory"),
  category: z
    .enum(["decision", "adr", "standup", "retrospective", "note", "knowledge"])
    .optional()
    .describe("Filter by memory category"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter by tags (entries matching any of these tags)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of results to return"),
});

registerTool({
  name: "workspace_memory_search",
  description:
    "Search the team's workspace memory for relevant past context — decisions, ADRs, standup notes, retrospectives, and shared knowledge. Uses semantic vector search for accurate retrieval.",
  parameters: SearchParams,

  async execute(params, ctx) {
    if (!ctx.workspaceId) {
      return { error: "No workspace context. This tool requires a workspace to be active." };
    }

    const results = await searchWorkspaceMemory({
      workspaceId: ctx.workspaceId,
      query: params.query,
      category: params.category,
      tags: params.tags,
      limit: params.limit,
    });

    if (results.length === 0) {
      return {
        results: [],
        message: "No relevant workspace memories found.",
      };
    }

    return {
      results: results.map((r) => ({
        id: r.id,
        category: r.category,
        content: r.content,
        tags: r.tags,
        relevance: r.score,
        createdAt: r.createdAt,
      })),
      message: `Found ${results.length} relevant workspace memories.`,
    };
  },
});
