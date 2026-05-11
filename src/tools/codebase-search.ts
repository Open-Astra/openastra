import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "../memory/embeddings.js";

// ── codebase_search ────────────────────────────────────────────────
// Semantic search over an indexed codebase using pgvector cosine
// similarity, with optional language and symbol filters.

const Params = z.object({
  query: z.string().describe("Natural language search query"),
  language: z.string().optional().describe("Filter by language"),
  symbolName: z.string().optional().describe("Filter by symbol name"),
  limit: z.number().int().min(1).max(20).default(5),
});

registerTool({
  name: "codebase_search",
  description:
    "Search an indexed codebase using semantic similarity. Supports filtering by language and symbol name. Use codebase_index first to index the repository.",
  parameters: Params,

  async execute(params, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.uid;
    const pool = getPool();

    // Generate query embedding
    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(params.query);
    } catch (err) {
      return {
        error: `Failed to generate query embedding: ${err instanceof Error ? err.message : String(err)}`,
        results: [],
      };
    }

    if (queryEmbedding.length === 0) {
      return {
        error: "Embedding generation returned empty vector.",
        results: [],
      };
    }

    const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

    // Build dynamic WHERE clauses
    const conditions: string[] = ["workspace_id = $1", "embedding IS NOT NULL"];
    const values: unknown[] = [workspaceId];
    let paramIdx = 2;

    if (params.language) {
      conditions.push(`language = $${paramIdx}`);
      values.push(params.language);
      paramIdx++;
    }

    if (params.symbolName) {
      // JSONB containment: symbols array contains the symbol name
      conditions.push(`symbols @> $${paramIdx}::jsonb`);
      values.push(JSON.stringify([params.symbolName]));
      paramIdx++;
    }

    const whereClause = conditions.join(" AND ");

    const query = `
      SELECT
        file_path,
        language,
        symbols,
        snippet,
        1 - (embedding <=> $${paramIdx}::vector) AS score
      FROM codebase_index
      WHERE ${whereClause}
      ORDER BY embedding <=> $${paramIdx}::vector
      LIMIT $${paramIdx + 1}
    `;

    values.push(embeddingLiteral, params.limit);

    const result = await pool.query<{
      file_path: string;
      language: string;
      symbols: string[];
      snippet: string;
      score: number;
    }>(query, values);

    return {
      results: result.rows.map((row) => ({
        filePath: row.file_path,
        language: row.language,
        symbols: row.symbols,
        score: Math.round(row.score * 1000) / 1000,
        snippet: row.snippet,
      })),
    };
  },
});
