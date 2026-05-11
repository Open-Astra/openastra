// ── Dynamic Tool Selection for Standalone CLI ─────────────────────
// Sends only core tools + keyword-triggered extras to the LLM.
// Reduces schema tokens from ~12k to ~2-5k per request.
// Execution is unaffected — policy.allow stays full in loop-stream.

import type { ToolSchema } from "../inference/types.js";

// Always included — the essential toolkit for any conversation
const CORE_TOOLS = new Set([
  "memory_search",
  "memory_write",
  "url_fetch",
  "file_read",
  "file_write",
  "code_execute",
  "shell_execute",
]);

// Keyword → extra tools mapping. Each group is activated when any
// trigger word appears in the user message (case-insensitive).
interface ToolGroup {
  triggers: string[];
  tools: string[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    triggers: ["search", "google", "browse", "website", "http", "api", "scrape", "link"],
    tools: ["web_search", "http_request", "x_search"],
  },
  {
    triggers: ["code", "program", "script", "debug", "refactor", "codebase", "repo", "git", "patch"],
    tools: ["codebase_search", "codebase_index", "patch_apply"],
  },
  {
    triggers: ["pdf", "document", "clipboard", "screenshot", "image", "photo", "picture", "paste"],
    tools: ["pdf_read", "clipboard", "screenshot", "multimodal_input", "image_generate"],
  },
  {
    triggers: ["database", "sql", "query", "table", "postgres", "graphql", "graph", "schema"],
    tools: ["database_query", "sql_query", "graphql_query", "graph_query", "graph_schema_evolve"],
  },
  {
    triggers: ["knowledge", "rag", "ingest", "retrieve", "workspace"],
    tools: [
      "rag_search", "knowledge_inject",
      "workspace_knowledge_write", "workspace_knowledge_search",
      "workspace_memory_write", "workspace_memory_search",
    ],
  },
  {
    triggers: ["compress", "export", "budget", "propagat", "consolidat", "decay", "consistency"],
    tools: [
      "memory_export", "memory_compress", "memory_budget",
      "memory_propagation", "memory_feedback", "consistency_check", "relation_decay",
    ],
  },
  {
    triggers: ["prop", "odds", "compare", "line", "kelly", "portfolio", "invest", "bet", "wager", "financial"],
    tools: ["prop_lookup", "line_compare", "kelly_criterion", "portfolio_optimizer"],
  },
  {
    triggers: ["research", "dream", "scenario", "plan", "strategy", "brainstorm"],
    tools: ["research_manage", "dream_manage", "scenario_engine"],
  },
  {
    triggers: ["article", "publish", "sanity", "cms", "draft", "story", "write"],
    tools: ["sanity_publish", "web_search"],
  },
  {
    triggers: ["model", "provider", "route", "ethic", "health", "scorecard", "evolution", "template", "prompt"],
    tools: ["model_inference", "provider_router", "ethical_check", "health_scorecard", "evolution_feedback", "prompt_templates"],
  },
];

// How many turns an activated group stays visible after the triggering message.
const STICKY_TURNS = 3;

/**
 * Creates a stateful filter that selects tool schemas based on the user message.
 * Core tools are always included; extra groups activate on keyword matches
 * and remain active for STICKY_TURNS follow-up messages so that multi-turn
 * conversations (e.g. "query the database" → "a list of all users") keep
 * the relevant tools visible.
 *
 * @param skillTools — Tool names required by the agent's skills. These are
 *   always visible regardless of keyword triggers, so skill workflows
 *   always visible regardless of keyword triggers.
 */
export function createStandaloneToolFilter(
  skillTools?: ReadonlySet<string>,
): (schemas: ToolSchema[], userMessage: string) => ToolSchema[] {
  // Track remaining sticky turns per group index
  const groupTtl = new Map<number, number>();

  return (schemas, userMessage) => {
    const lower = userMessage.toLowerCase();

    // Collect which tool names should be visible
    const visible = new Set(CORE_TOOLS);

    // Always include tools required by the agent's skills
    if (skillTools) {
      for (const name of skillTools) visible.add(name);
    }

    for (let i = 0; i < TOOL_GROUPS.length; i++) {
      const group = TOOL_GROUPS[i]!;

      if (group.triggers.some((t) => lower.includes(t))) {
        // Fresh trigger — reset TTL
        groupTtl.set(i, STICKY_TURNS);
      }

      const ttl = groupTtl.get(i) ?? 0;
      if (ttl > 0) {
        for (const tool of group.tools) {
          visible.add(tool);
        }
        // Decrement (will be 0 and pruned after STICKY_TURNS messages)
        groupTtl.set(i, ttl - 1);
      } else {
        groupTtl.delete(i);
      }
    }

    return schemas.filter((s) => visible.has(s.function.name));
  };
}
