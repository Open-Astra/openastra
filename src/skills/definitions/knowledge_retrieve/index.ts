import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Knowledge Retrieve Skill ──────────────────────────────────────
// In-memory knowledge store. Supports ingesting key/value pairs
// and retrieving them via simple substring-based search.

const knowledgeStore = new Map<string, string>();

const KnowledgeIngestParams = z.object({
  key: z.string().describe("Unique key to store the content under"),
  content: z.string().describe("Content to store in the knowledge base"),
});

const KnowledgeRetrieveParams = z.object({
  query: z.string().describe("Search query to find matching knowledge entries"),
});

const knowledgeRetrieveSkill: SkillDefinition = {
  name: "knowledge_retrieve",
  version: "1.0.0",

  manifest: {
    id: "knowledge_retrieve",
    name: "Knowledge Retrieve",
    description: "In-memory knowledge store with ingestion and retrieval. Uses simple substring matching for search.",
    category: "search",
    tools: ["knowledge_retrieve", "knowledge_ingest"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "knowledge_ingest",
      description: "Store a piece of knowledge in the in-memory knowledge base. Provide a unique key and the content to store.",
      parameters: KnowledgeIngestParams,

      async execute(params) {
        const existed = knowledgeStore.has(params.key);
        knowledgeStore.set(params.key, params.content);

        return {
          success: true,
          key: params.key,
          action: existed ? "updated" : "created",
          totalEntries: knowledgeStore.size,
        };
      },
    });

    ctx.registerTool({
      name: "knowledge_retrieve",
      description: "Search the in-memory knowledge base. Returns entries where the key or content matches the query via substring search.",
      parameters: KnowledgeRetrieveParams,

      async execute(params) {
        const query = params.query.toLowerCase();
        const matches: Array<{ key: string; content: string; matchType: string }> = [];

        for (const [key, content] of knowledgeStore) {
          const keyMatch = key.toLowerCase().includes(query);
          const contentMatch = content.toLowerCase().includes(query);

          if (keyMatch || contentMatch) {
            matches.push({
              key,
              content,
              matchType: keyMatch && contentMatch ? "key+content" : keyMatch ? "key" : "content",
            });
          }
        }

        // Sort by match type: key+content first, then key, then content
        const priority: Record<string, number> = { "key+content": 0, "key": 1, "content": 2 };
        matches.sort((a, b) => priority[a.matchType] - priority[b.matchType]);

        return {
          query: params.query,
          matchCount: matches.length,
          totalEntries: knowledgeStore.size,
          matches,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "knowledge_retrieve",
      instructions: "You can store and search knowledge using `knowledge_ingest` (to store) and `knowledge_retrieve` (to search). The knowledge base is in-memory.",
    };
  },
};

export default knowledgeRetrieveSkill;
