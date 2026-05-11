import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";
import { getTypesense } from "../../../config/typesense.js";
import { generateEmbedding } from "../../../memory/embeddings.js";

// ── Persistent Knowledge Store ─────────────────────────────────────
// Replaces the in-memory knowledge_retrieve skill with durable
// Postgres storage and Typesense hybrid search. Knowledge survives
// restarts and supports semantic retrieval.

const COLLECTION = "knowledge_store";

const KnowledgeIngestParams = z.object({
  key: z.string().describe("Unique key to store the content under"),
  content: z.string().describe("Content to store in the knowledge base"),
  tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
});

const KnowledgeRetrieveParams = z.object({
  query: z.string().describe("Search query — supports keyword and semantic matching"),
  limit: z.number().min(1).max(20).optional().describe("Max results to return (default 5)"),
});

const KnowledgeDeleteParams = z.object({
  key: z.string().describe("Key of the knowledge entry to delete"),
});

async function ensureTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_store (
      id SERIAL PRIMARY KEY,
      uid TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(uid, key)
    )
  `);
}

async function ensureCollection(): Promise<void> {
  const ts = getTypesense();
  try {
    await ts.collections(COLLECTION).retrieve();
  } catch {
    await ts.collections().create({
      name: COLLECTION,
      fields: [
        { name: "uid", type: "string" as const, facet: true },
        { name: "key", type: "string" as const },
        { name: "content", type: "string" as const },
        { name: "tags", type: "string" as const },
        { name: "timestamp", type: "int64" as const },
        { name: "embedding", type: "float[]" as const, num_dim: 768 },
      ],
    });
  }
}

let initialized = false;

const persistentKnowledgeSkill: SkillDefinition = {
  name: "persistent_knowledge",
  version: "1.0.0",

  manifest: {
    id: "persistent_knowledge",
    name: "Persistent Knowledge",
    description: "Durable knowledge store with Postgres persistence and Typesense hybrid search. Survives restarts.",
    category: "search",
    tools: ["knowledge_ingest", "knowledge_retrieve", "knowledge_delete"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "knowledge_ingest",
      description: "Store a piece of knowledge persistently. Provide a unique key and content. Supports tags for categorization.",
      parameters: KnowledgeIngestParams,

      async execute(params, toolCtx) {
        if (!initialized) {
          await ensureTable();
          await ensureCollection().catch(() => {});
          initialized = true;
        }

        const pool = getPool();
        const uid = toolCtx.uid;
        const tags = params.tags ?? [];

        const { rows } = await pool.query<{ id: number }>(
          `INSERT INTO knowledge_store (uid, key, content, tags, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (uid, key)
           DO UPDATE SET content = $3, tags = $4, updated_at = NOW()
           RETURNING id`,
          [uid, params.key, params.content, tags],
        );

        // Index in Typesense (fire-and-forget)
        generateEmbedding(`${params.key}: ${params.content}`)
          .then((embedding) =>
            getTypesense()
              .collections(COLLECTION)
              .documents()
              .upsert({
                id: `${uid}:kb:${params.key}`,
                uid,
                key: params.key,
                content: params.content,
                tags: tags.join(","),
                timestamp: Date.now(),
                embedding,
              }),
          )
          .catch(() => {});

        return {
          success: true,
          key: params.key,
          id: rows[0]?.id,
          tags,
          action: "upserted",
        };
      },
    });

    ctx.registerTool({
      name: "knowledge_retrieve",
      description: "Search the persistent knowledge base using keyword and semantic matching. Returns entries ranked by relevance.",
      parameters: KnowledgeRetrieveParams,

      async execute(params, toolCtx) {
        if (!initialized) {
          await ensureTable();
          await ensureCollection().catch(() => {});
          initialized = true;
        }

        const uid = toolCtx.uid;
        const limit = params.limit ?? 5;

        // Try Typesense hybrid search first
        try {
          const queryEmbedding = await generateEmbedding(params.query);
          const ts = getTypesense();

          const results = await ts
            .collections(COLLECTION)
            .documents()
            .search({
              q: params.query,
              query_by: "content,key",
              filter_by: `uid:=${uid}`,
              sort_by: "_text_match:desc,_vector_distance:asc",
              vector_query: `embedding:([${queryEmbedding.join(",")}], k:${limit * 2})`,
              per_page: limit,
              exclude_fields: "embedding",
            });

          if (results.hits && results.hits.length > 0) {
            const matches = results.hits.map((hit) => {
              const doc = hit.document as Record<string, unknown>;
              return {
                key: doc.key as string,
                content: doc.content as string,
                tags: ((doc.tags as string) || "").split(",").filter(Boolean),
                matchType: "hybrid" as const,
              };
            });

            return { query: params.query, matchCount: matches.length, matches };
          }
        } catch {
          // Typesense unavailable, fall back to Postgres
        }

        // Postgres fallback: substring search
        const pool = getPool();
        const { rows } = await pool.query<{
          key: string;
          content: string;
          tags: string[];
        }>(
          `SELECT key, content, tags FROM knowledge_store
           WHERE uid = $1 AND (key ILIKE $2 OR content ILIKE $2)
           ORDER BY updated_at DESC LIMIT $3`,
          [uid, `%${params.query}%`, limit],
        );

        return {
          query: params.query,
          matchCount: rows.length,
          matches: rows.map((r) => ({
            key: r.key,
            content: r.content,
            tags: r.tags,
            matchType: "substring" as const,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "knowledge_delete",
      description: "Delete a knowledge entry by key.",
      parameters: KnowledgeDeleteParams,

      async execute(params, toolCtx) {
        if (!initialized) {
          await ensureTable();
          initialized = true;
        }

        const pool = getPool();
        const uid = toolCtx.uid;

        const result = await pool.query(
          "DELETE FROM knowledge_store WHERE uid = $1 AND key = $2",
          [uid, params.key],
        );

        // Remove from Typesense
        getTypesense()
          .collections(COLLECTION)
          .documents(`${uid}:kb:${params.key}`)
          .delete()
          .catch(() => {});

        return {
          success: true,
          deleted: (result.rowCount ?? 0) > 0,
          key: params.key,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "persistent_knowledge",
      instructions:
        "You can store and search knowledge persistently using `knowledge_ingest` (to store with optional tags), `knowledge_retrieve` (hybrid keyword + semantic search), and `knowledge_delete`. Knowledge survives restarts.",
    };
  },
};

export default persistentKnowledgeSkill;
