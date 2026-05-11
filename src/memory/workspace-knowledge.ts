// ── Workspace Knowledge Base ────────────────────────────────────────
// Structured knowledge entries scoped to a workspace. Supports ADRs,
// standards, runbooks, FAQs, and glossary items. Entries have a
// lifecycle (active → deprecated → superseded) and are searchable
// via pgvector cosine similarity.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-knowledge");

// ── Create ─────────────────────────────────────────────────────────

export async function createKnowledgeEntry(params: {
  workspaceId: string;
  authorId: string;
  type: "adr" | "standard" | "runbook" | "faq" | "glossary";
  title: string;
  content: string;
  tags?: string[];
}): Promise<{ id: string }> {
  const pool = getPool();
  const id = randomUUID();
  const tags = params.tags ?? [];

  // Generate embedding from title + content for search
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(`${params.title}\n\n${params.content}`);
  } catch (err) {
    log.warn("Embedding generation failed, storing without vector:", err instanceof Error ? err.message : String(err));
  }

  await pool.query(
    `INSERT INTO workspace_knowledge (id, workspace_id, author_id, type, title, content, tags, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      params.workspaceId,
      params.authorId,
      params.type,
      params.title,
      params.content,
      tags,
      embedding ? JSON.stringify(embedding) : null,
    ],
  );

  return { id };
}

// ── Search (vector similarity) ─────────────────────────────────────

export async function searchKnowledge(params: {
  workspaceId: string;
  query: string;
  type?: string;
  status?: string;
  limit?: number;
}): Promise<Array<{ id: string; type: string; title: string; content: string; status: string; score: number }>> {
  const pool = getPool();
  const limit = params.limit ?? 10;

  // Generate query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(params.query);
  } catch (err) {
    log.warn("Query embedding failed, falling back to text match:", err instanceof Error ? err.message : String(err));
    // Fallback: return recent entries without scoring
    return fallbackTextSearch(params);
  }

  // Build dynamic WHERE clauses
  const conditions: string[] = ["workspace_id = $1", "embedding IS NOT NULL"];
  const values: unknown[] = [params.workspaceId];
  let paramIdx = 2;

  if (params.type) {
    conditions.push(`type = $${paramIdx}`);
    values.push(params.type);
    paramIdx++;
  }

  if (params.status) {
    conditions.push(`status = $${paramIdx}`);
    values.push(params.status);
    paramIdx++;
  }

  // Add query embedding as the last parameter
  values.push(JSON.stringify(queryEmbedding));

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<{
    id: string;
    type: string;
    title: string;
    content: string;
    status: string;
    score: number;
  }>(
    `SELECT id, type, title, content, status,
            1 - (embedding <=> $${paramIdx}::vector) AS score
     FROM workspace_knowledge
     WHERE ${whereClause}
     ORDER BY embedding <=> $${paramIdx}::vector ASC
     LIMIT $${paramIdx + 1}`,
    [...values, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    status: r.status,
    score: Math.round(r.score * 1000) / 1000,
  }));
}

// ── Fallback text search (when embedding fails) ────────────────────

async function fallbackTextSearch(params: {
  workspaceId: string;
  query: string;
  type?: string;
  status?: string;
  limit?: number;
}): Promise<Array<{ id: string; type: string; title: string; content: string; status: string; score: number }>> {
  const pool = getPool();
  const limit = params.limit ?? 10;

  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [params.workspaceId];
  let paramIdx = 2;

  if (params.type) {
    conditions.push(`type = $${paramIdx}`);
    values.push(params.type);
    paramIdx++;
  }

  if (params.status) {
    conditions.push(`status = $${paramIdx}`);
    values.push(params.status);
    paramIdx++;
  }

  const whereClause = conditions.join(" AND ");

  const { rows } = await pool.query<{
    id: string;
    type: string;
    title: string;
    content: string;
    status: string;
  }>(
    `SELECT id, type, title, content, status
     FROM workspace_knowledge
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIdx}`,
    [...values, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    status: r.status,
    score: 0,
  }));
}

// ── Update ─────────────────────────────────────────────────────────

export async function updateKnowledgeEntry(params: {
  id: string;
  workspaceId: string;
  title?: string;
  content?: string;
  status?: "active" | "deprecated" | "superseded";
  supersededBy?: string;
  tags?: string[];
}): Promise<void> {
  const pool = getPool();

  // Build SET clauses dynamically
  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (params.title !== undefined) {
    setClauses.push(`title = $${paramIdx}`);
    values.push(params.title);
    paramIdx++;
  }

  if (params.content !== undefined) {
    setClauses.push(`content = $${paramIdx}`);
    values.push(params.content);
    paramIdx++;
  }

  if (params.status !== undefined) {
    setClauses.push(`status = $${paramIdx}`);
    values.push(params.status);
    paramIdx++;
  }

  if (params.supersededBy !== undefined) {
    setClauses.push(`superseded_by = $${paramIdx}`);
    values.push(params.supersededBy);
    paramIdx++;
  }

  if (params.tags !== undefined) {
    setClauses.push(`tags = $${paramIdx}`);
    values.push(params.tags);
    paramIdx++;
  }

  // Re-generate embedding if title or content changed
  if (params.title !== undefined || params.content !== undefined) {
    // Fetch current values for the fields that weren't updated
    const { rows } = await pool.query<{ title: string; content: string }>(
      "SELECT title, content FROM workspace_knowledge WHERE id = $1 AND workspace_id = $2",
      [params.id, params.workspaceId],
    );

    if (rows.length > 0) {
      const currentTitle = params.title ?? rows[0]!.title;
      const currentContent = params.content ?? rows[0]!.content;

      try {
        const embedding = await generateEmbedding(`${currentTitle}\n\n${currentContent}`);
        setClauses.push(`embedding = $${paramIdx}`);
        values.push(JSON.stringify(embedding));
        paramIdx++;
      } catch (err) {
        log.warn("Embedding update failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Add WHERE params
  values.push(params.id, params.workspaceId);

  await pool.query(
    `UPDATE workspace_knowledge
     SET ${setClauses.join(", ")}
     WHERE id = $${paramIdx} AND workspace_id = $${paramIdx + 1}`,
    values,
  );
}
