// ── Workspace Memory ────────────────────────────────────────────────
// Team-scoped memory with vector search. Entries are categorized and
// tagged, stored in Postgres with pgvector embeddings for semantic
// retrieval. Each entry is scoped to a workspace so all team members
// share the same memory corpus.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-memory");

// ── Write ──────────────────────────────────────────────────────────

export async function writeWorkspaceMemory(params: {
  workspaceId: string;
  authorId: string;
  category: "decision" | "adr" | "standup" | "retrospective" | "note" | "knowledge";
  content: string;
  tags?: string[];
}): Promise<{ id: string }> {
  const pool = getPool();
  const id = randomUUID();
  const tags = params.tags ?? [];

  // Generate embedding for semantic search
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(params.content);
  } catch (err) {
    log.warn("Embedding generation failed, storing without vector:", err instanceof Error ? err.message : String(err));
  }

  await pool.query(
    `INSERT INTO workspace_memory (id, workspace_id, author_id, category, content, tags, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      params.workspaceId,
      params.authorId,
      params.category,
      params.content,
      tags,
      embedding ? JSON.stringify(embedding) : null,
    ],
  );

  return { id };
}

// ── Search (vector similarity) ─────────────────────────────────────

export async function searchWorkspaceMemory(params: {
  workspaceId: string;
  query: string;
  category?: string;
  tags?: string[];
  limit?: number;
}): Promise<Array<{ id: string; category: string; content: string; tags: string[]; score: number; createdAt: string }>> {
  const pool = getPool();
  const limit = params.limit ?? 10;

  // Generate query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(params.query);
  } catch (err) {
    log.warn("Query embedding failed, falling back to text search:", err instanceof Error ? err.message : String(err));
    const fallback = await listWorkspaceMemory({ workspaceId: params.workspaceId, category: params.category, limit });
    return fallback.map((r) => ({ ...r, score: 0 }));
  }

  // Build dynamic WHERE clauses
  const conditions: string[] = ["workspace_id = $1", "embedding IS NOT NULL"];
  const values: unknown[] = [params.workspaceId];
  let paramIdx = 2;

  if (params.category) {
    conditions.push(`category = $${paramIdx}`);
    values.push(params.category);
    paramIdx++;
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags && $${paramIdx}`);
    values.push(params.tags);
    paramIdx++;
  }

  // Add query embedding as the last parameter
  values.push(JSON.stringify(queryEmbedding));

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<{
    id: string;
    category: string;
    content: string;
    tags: string[];
    score: number;
    created_at: string;
  }>(
    `SELECT id, category, content, tags,
            1 - (embedding <=> $${paramIdx}::vector) AS score,
            created_at
     FROM workspace_memory
     WHERE ${whereClause}
     ORDER BY embedding <=> $${paramIdx}::vector ASC
     LIMIT $${paramIdx + 1}`,
    [...values, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    content: r.content,
    tags: r.tags,
    score: Math.round(r.score * 1000) / 1000,
    createdAt: r.created_at,
  }));
}

// ── List (chronological) ───────────────────────────────────────────

export async function listWorkspaceMemory(params: {
  workspaceId: string;
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<Array<{ id: string; category: string; content: string; tags: string[]; createdAt: string }>> {
  const pool = getPool();
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  // Build dynamic WHERE clauses
  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [params.workspaceId];
  let paramIdx = 2;

  if (params.category) {
    conditions.push(`category = $${paramIdx}`);
    values.push(params.category);
    paramIdx++;
  }

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<{
    id: string;
    category: string;
    content: string;
    tags: string[];
    created_at: string;
  }>(
    `SELECT id, category, content, tags, created_at
     FROM workspace_memory
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset],
  );

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    content: r.content,
    tags: r.tags,
    createdAt: r.created_at,
  }));
}
