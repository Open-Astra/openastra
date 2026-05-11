import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { getTypesense } from "../config/typesense.js";

// ── Procedural Memory ───────────────────────────────────────────────
// Stores executable "how-to" knowledge as structured procedures
// alongside raw episodic history. Retrieval can return either a
// memory recall (episodic) or a runnable procedure.
//
// Postgres: procedural_memory table
// Typesense: procedural_memory collection

// ── Types ───────────────────────────────────────────────────────────

export type ProcedureType =
  | "workflow"       // multi-step sequence
  | "decision_tree"  // conditional logic
  | "template"       // reusable prompt/format
  | "rule"           // simple if-then rule
  | "snippet";       // code or formula

export interface ProcedureStep {
  order: number;
  action: string;        // what to do
  condition?: string;    // when to do it (optional guard)
  toolCall?: string;     // tool to invoke
  toolParams?: Record<string, unknown>; // template params for the tool
  expectedOutput?: string;
}

export interface ProceduralMemory {
  id: string;
  uid: string;
  type: ProcedureType;
  name: string;
  description: string;
  trigger: string;       // when this procedure should activate
  steps: ProcedureStep[];
  tags: string[];
  // Performance tracking
  executionCount: number;
  successCount: number;
  lastExecutedAt: number | null;
  // Metadata
  createdAt: number;
  updatedAt: number;
  source: "user" | "agent" | "curator"; // who created it
}

export interface ProcedureSearchResult {
  procedure: ProceduralMemory;
  score: number;
  matchType: "trigger" | "semantic" | "tag";
}

// ── Row Mapper ──────────────────────────────────────────────────────

function rowToProcedure(row: Record<string, unknown>): ProceduralMemory {
  return {
    id: row.id as string,
    uid: row.user_id as string,
    type: (row.type as ProcedureType) ?? "workflow",
    name: row.title as string,
    description: row.content as string,
    trigger: (row.trigger_pattern as string) ?? "",
    steps: (row.steps as ProcedureStep[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    executionCount: (row.execution_count as number) ?? 0,
    successCount: (row.success_count as number) ?? 0,
    lastExecutedAt: row.last_executed_at ? Number(row.last_executed_at) : null,
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
    source: (row.source as ProceduralMemory["source"]) ?? "user",
  };
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function createProcedure(
  uid: string,
  procedure: Omit<ProceduralMemory, "id" | "uid" | "executionCount" | "successCount" | "lastExecutedAt" | "createdAt" | "updatedAt">,
): Promise<ProceduralMemory> {
  const pool = getPool();
  const id = randomUUID();

  await pool.query(
    `INSERT INTO procedural_memory
       (id, user_id, title, content, type, trigger_pattern, steps, tags, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      id,
      uid,
      procedure.name,
      procedure.description,
      procedure.type,
      procedure.trigger,
      JSON.stringify(procedure.steps),
      procedure.tags,
      procedure.source,
    ],
  );

  const doc: ProceduralMemory = {
    ...procedure,
    id,
    uid,
    executionCount: 0,
    successCount: 0,
    lastExecutedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Index in Typesense
  indexProcedure(uid, doc).catch((err) =>
    console.error("[procedural] Failed to index procedure:", err),
  );

  console.log(`[procedural] Created "${doc.name}" (${doc.type}) for uid=${uid}`);
  return doc;
}

export async function getProcedure(uid: string, procedureId: string): Promise<ProceduralMemory | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM procedural_memory WHERE id = $1 AND user_id = $2",
    [procedureId, uid],
  );
  return rows.length > 0 ? rowToProcedure(rows[0]) : null;
}

export async function listProcedures(
  uid: string,
  type?: ProcedureType,
): Promise<ProceduralMemory[]> {
  const pool = getPool();

  if (type) {
    const { rows } = await pool.query(
      "SELECT * FROM procedural_memory WHERE user_id = $1 AND type = $2 ORDER BY updated_at DESC LIMIT 50",
      [uid, type],
    );
    return rows.map(rowToProcedure);
  }

  const { rows } = await pool.query(
    "SELECT * FROM procedural_memory WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
    [uid],
  );
  return rows.map(rowToProcedure);
}

export async function updateProcedure(
  uid: string,
  procedureId: string,
  updates: Partial<Pick<ProceduralMemory, "name" | "description" | "trigger" | "steps" | "tags">>,
): Promise<void> {
  const pool = getPool();

  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    setClauses.push(`title = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push(`content = $${idx++}`);
    values.push(updates.description);
  }
  if (updates.trigger !== undefined) {
    setClauses.push(`trigger_pattern = $${idx++}`);
    values.push(updates.trigger);
  }
  if (updates.steps !== undefined) {
    setClauses.push(`steps = $${idx++}::jsonb`);
    values.push(JSON.stringify(updates.steps));
  }
  if (updates.tags !== undefined) {
    setClauses.push(`tags = $${idx++}`);
    values.push(updates.tags);
  }

  values.push(procedureId, uid);

  await pool.query(
    `UPDATE procedural_memory SET ${setClauses.join(", ")}
     WHERE id = $${idx++} AND user_id = $${idx}`,
    values,
  );
}

export async function recordExecution(
  uid: string,
  procedureId: string,
  success: boolean,
): Promise<void> {
  const pool = getPool();

  if (success) {
    await pool.query(
      `UPDATE procedural_memory
       SET execution_count = execution_count + 1,
           success_count = success_count + 1,
           last_executed_at = $1
       WHERE id = $2 AND user_id = $3`,
      [Date.now(), procedureId, uid],
    );
  } else {
    await pool.query(
      `UPDATE procedural_memory
       SET execution_count = execution_count + 1,
           last_executed_at = $1
       WHERE id = $2 AND user_id = $3`,
      [Date.now(), procedureId, uid],
    );
  }
}

// ── Search: Find Relevant Procedures ────────────────────────────────
// Checks trigger patterns first (exact/fuzzy), then falls back to
// semantic search over descriptions and steps.

export async function searchProcedures(
  uid: string,
  query: string,
  topK: number = 3,
): Promise<ProcedureSearchResult[]> {
  const results: ProcedureSearchResult[] = [];

  // 1. Check trigger patterns (fast, exact-ish match)
  const allProcedures = await listProcedures(uid);
  const queryLower = query.toLowerCase();

  for (const proc of allProcedures) {
    const triggerLower = proc.trigger.toLowerCase();
    if (queryLower.includes(triggerLower) || triggerLower.includes(queryLower)) {
      results.push({ procedure: proc, score: 0.95, matchType: "trigger" });
    } else {
      // Check tag matches
      const matchedTag = proc.tags.some((t) => queryLower.includes(t.toLowerCase()));
      if (matchedTag) {
        results.push({ procedure: proc, score: 0.7, matchType: "tag" });
      }
    }
  }

  // 2. Semantic search via Typesense if not enough trigger matches
  if (results.length < topK) {
    try {
      const ts = getTypesense();
      const queryEmbedding = await generateEmbedding(query);

      const searchResults = await ts
        .collections("procedural_memory")
        .documents()
        .search({
          q: query,
          query_by: "name,description,trigger",
          filter_by: `uid:=${uid}`,
          vector_query: `embedding:([${queryEmbedding.join(",")}], k:${topK * 2})`,
          per_page: topK,
          exclude_fields: "embedding",
        });

      const existingIds = new Set(results.map((r) => r.procedure.id));

      for (const hit of searchResults.hits ?? []) {
        const doc = hit.document as Record<string, unknown>;
        const procId = doc.procedureId as string;
        if (existingIds.has(procId)) continue;

        const procedure = await getProcedure(uid, procId);
        if (procedure) {
          results.push({ procedure, score: 0.5, matchType: "semantic" });
        }
      }
    } catch {
      // Typesense collection may not exist yet
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Render Procedure for Agent Context ──────────────────────────────
// Converts a procedure into a text format that the agent can follow.

export function renderProcedure(proc: ProceduralMemory): string {
  const lines: string[] = [
    `## Procedure: ${proc.name}`,
    `Type: ${proc.type} | Trigger: "${proc.trigger}"`,
    `Success rate: ${proc.executionCount > 0 ? Math.round((proc.successCount / proc.executionCount) * 100) : "N/A"}%`,
    "",
    proc.description,
    "",
    "### Steps:",
  ];

  for (const step of proc.steps) {
    let line = `${step.order}. ${step.action}`;
    if (step.condition) line += ` [IF: ${step.condition}]`;
    if (step.toolCall) line += ` → call \`${step.toolCall}\``;
    lines.push(line);
  }

  return lines.join("\n");
}

// ── Typesense Indexing ──────────────────────────────────────────────

async function indexProcedure(uid: string, proc: ProceduralMemory): Promise<void> {
  const ts = getTypesense();
  const text = `${proc.name}. ${proc.description}. Trigger: ${proc.trigger}. Steps: ${proc.steps.map((s) => s.action).join(". ")}`;
  const embedding = await generateEmbedding(text);

  await ts.collections("procedural_memory").documents().upsert({
    id: `${uid}:proc:${proc.id}`,
    uid,
    procedureId: proc.id,
    name: proc.name,
    description: proc.description,
    trigger: proc.trigger,
    type: proc.type,
    tags: proc.tags.join(","),
    timestamp: proc.createdAt,
    embedding,
  });
}

// ── Ensure Collection ───────────────────────────────────────────────

export async function ensureProceduralCollection(): Promise<void> {
  const ts = getTypesense();
  const name = "procedural_memory";

  try {
    await ts.collections(name).retrieve();
  } catch {
    await ts.collections().create({
      name,
      fields: [
        { name: "uid", type: "string" as const, facet: true },
        { name: "procedureId", type: "string" as const },
        { name: "name", type: "string" as const },
        { name: "description", type: "string" as const },
        { name: "trigger", type: "string" as const },
        { name: "type", type: "string" as const, facet: true },
        { name: "tags", type: "string" as const },
        { name: "timestamp", type: "int64" as const },
        { name: "embedding", type: "float[]" as const, num_dim: 768 },
      ],
    });
    console.log(`[procedural] Created Typesense collection: ${name}`);
  }
}
