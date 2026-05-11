import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getTypesense } from "../../../config/typesense.js";
import { generateEmbedding, generateEmbeddings } from "../../../memory/embeddings.js";

// ── Vector / Semantic Search Skill ──────────────────────────────
// Standalone semantic search over arbitrary document collections.
// Users can create named collections, ingest documents with
// embeddings, and run hybrid BM25+vector search queries.
//
// Unlike the built-in memory search (which operates on daily/profile
// chunks), this skill lets agents build and query custom indices.

const COLLECTION_PREFIX = "vs_";

const CreateCollectionParams = z.object({
  name: z.string().min(1).max(50).describe("Collection name (alphanumeric + underscores)"),
  description: z.string().optional().describe("What this collection contains"),
});

const IngestDocParams = z.object({
  collection: z.string().describe("Collection name to add the document to"),
  docId: z.string().describe("Unique document identifier"),
  content: z.string().describe("Document text content"),
  metadata: z.record(z.string(), z.string()).optional().describe("Optional key-value metadata"),
});

const SearchDocsParams = z.object({
  collection: z.string().describe("Collection name to search"),
  query: z.string().describe("Search query — supports keyword and semantic matching"),
  limit: z.number().min(1).max(20).optional().describe("Max results (default 5)"),
  keywordWeight: z.number().min(0).max(1).optional().describe("BM25 keyword weight 0-1 (default 0.3, rest is vector)"),
});

const BatchIngestParams = z.object({
  collection: z.string().describe("Collection name"),
  documents: z.array(
    z.object({
      docId: z.string(),
      content: z.string(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  ).min(1).max(50).describe("Documents to ingest (max 50 per batch)"),
});

function collectionName(uid: string, name: string): string {
  return `${COLLECTION_PREFIX}${uid.slice(0, 8)}_${name}`;
}

async function ensureCollection(fullName: string): Promise<void> {
  const ts = getTypesense();
  try {
    await ts.collections(fullName).retrieve();
  } catch {
    await ts.collections().create({
      name: fullName,
      fields: [
        { name: "uid", type: "string" as const, facet: true },
        { name: "docId", type: "string" as const },
        { name: "content", type: "string" as const },
        { name: "metadata", type: "string" as const, optional: true },
        { name: "timestamp", type: "int64" as const },
        { name: "embedding", type: "float[]" as const, num_dim: 768 },
      ],
    });
  }
}

const vectorSearchSkill: SkillDefinition = {
  name: "vector_search",
  version: "1.0.0",

  manifest: {
    id: "vector_search",
    name: "Vector Search",
    description: "Create custom document collections with hybrid BM25 + vector semantic search. Build and query your own search indices.",
    category: "search",
    tools: [
      "vector_create_collection",
      "vector_ingest",
      "vector_search",
      "vector_batch_ingest",
    ],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "vector_create_collection",
      description: "Create a new named document collection for semantic search.",
      parameters: CreateCollectionParams,

      async execute(params, toolCtx) {
        const fullName = collectionName(toolCtx.uid, params.name);
        await ensureCollection(fullName);

        return {
          success: true,
          collection: params.name,
          internalName: fullName,
          description: params.description ?? null,
        };
      },
    });

    ctx.registerTool({
      name: "vector_ingest",
      description: "Add a document to a collection. Automatically generates embeddings for semantic search.",
      parameters: IngestDocParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const fullName = collectionName(uid, params.collection);
        await ensureCollection(fullName);

        const embedding = await generateEmbedding(params.content);
        const ts = getTypesense();

        await ts.collections(fullName).documents().upsert({
          id: `${uid}:${params.docId}`,
          uid,
          docId: params.docId,
          content: params.content,
          metadata: params.metadata ? JSON.stringify(params.metadata) : "{}",
          timestamp: Date.now(),
          embedding,
        });

        return {
          success: true,
          collection: params.collection,
          docId: params.docId,
          contentLength: params.content.length,
        };
      },
    });

    ctx.registerTool({
      name: "vector_batch_ingest",
      description: "Ingest multiple documents into a collection at once. More efficient than individual ingestion for bulk operations.",
      parameters: BatchIngestParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const fullName = collectionName(uid, params.collection);
        await ensureCollection(fullName);

        const texts = params.documents.map((d) => d.content);
        const embeddings = await generateEmbeddings(texts);
        const ts = getTypesense();

        const documents = params.documents.map((doc, i) => ({
          id: `${uid}:${doc.docId}`,
          uid,
          docId: doc.docId,
          content: doc.content,
          metadata: doc.metadata ? JSON.stringify(doc.metadata) : "{}",
          timestamp: Date.now(),
          embedding: embeddings[i],
        }));

        await ts.collections(fullName).documents().import(documents, { action: "upsert" });

        return {
          success: true,
          collection: params.collection,
          documentsIngested: params.documents.length,
        };
      },
    });

    ctx.registerTool({
      name: "vector_search",
      description: "Search a collection using hybrid BM25 keyword + vector semantic matching. Adjustable keyword/vector weighting.",
      parameters: SearchDocsParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const fullName = collectionName(uid, params.collection);
        const limit = params.limit ?? 5;
        const keywordWeight = params.keywordWeight ?? 0.3;
        const vectorWeight = 1 - keywordWeight;

        const queryEmbedding = await generateEmbedding(params.query);
        const ts = getTypesense();

        const results = await ts
          .collections(fullName)
          .documents()
          .search({
            q: params.query,
            query_by: "content",
            filter_by: `uid:=${uid}`,
            sort_by: "_text_match:desc,_vector_distance:asc",
            vector_query: `embedding:([${queryEmbedding.join(",")}], k:${limit * 2})`,
            per_page: limit,
            exclude_fields: "embedding",
          });

        if (!results.hits?.length) {
          return { query: params.query, collection: params.collection, matchCount: 0, matches: [] };
        }

        const matches = results.hits.map((hit) => {
          const doc = hit.document as Record<string, unknown>;
          const textScore = (hit.text_match ?? 0) as number;
          const vectorDistance = ((hit as unknown as Record<string, unknown>).vector_distance ?? 2) as number;

          const normalizedText = Math.min(textScore / 1000000, 1);
          const vectorSimilarity = 1 - vectorDistance / 2;
          const score = keywordWeight * normalizedText + vectorWeight * vectorSimilarity;

          return {
            docId: doc.docId as string,
            content: (doc.content as string).slice(0, 500),
            metadata: doc.metadata ? JSON.parse(doc.metadata as string) : {},
            score: Math.round(score * 1000) / 1000,
          };
        });

        return {
          query: params.query,
          collection: params.collection,
          matchCount: matches.length,
          weights: { keyword: keywordWeight, vector: vectorWeight },
          matches,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "vector_search",
      instructions:
        "You can build custom search indices: `vector_create_collection` creates a named collection, `vector_ingest` / `vector_batch_ingest` adds documents with auto-generated embeddings, and `vector_search` runs hybrid keyword + semantic search with adjustable weighting.",
    };
  },
};

export default vectorSearchSkill;
