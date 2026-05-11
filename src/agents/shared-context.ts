// ── Shared Context Windows ──────────────────────────────────────────
// Shared context prefix for agents in the same workspace.
// Entries are stored in Postgres and assembled into a prompt prefix
// that every agent in the workspace receives.

import { getPool } from "../config/postgres.js";

export interface SharedContextEntry {
  id: string;
  workspaceId: string;
  key: string;
  content: string;
  category: "knowledge" | "decisions" | "projects" | "general";
  priority: number;
  addedBy: string;
  createdAt: string;
}

/** Add a new shared context entry (upserts on workspace_id + key). */
export async function addSharedContext(
  workspaceId: string,
  key: string,
  content: string,
  category: string,
  priority: number,
  addedBy: string,
): Promise<SharedContextEntry> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    workspace_id: string;
    key: string;
    content: string;
    category: string;
    priority: number;
    added_by: string;
    created_at: Date;
  }>(
    `INSERT INTO workspace_shared_context (workspace_id, key, content, category, priority, added_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, key) DO UPDATE
       SET content = EXCLUDED.content,
           category = EXCLUDED.category,
           priority = EXCLUDED.priority,
           updated_at = now()
     RETURNING *`,
    [workspaceId, key, content, category, priority, addedBy],
  );
  const r = rows[0];
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    key: r.key,
    content: r.content,
    category: r.category as SharedContextEntry["category"],
    priority: r.priority,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  };
}

/** Retrieve shared context entries for a workspace, sorted by priority DESC. */
export async function getSharedContext(
  workspaceId: string,
  opts?: { category?: string; maxTokens?: number },
): Promise<SharedContextEntry[]> {
  const pool = getPool();
  const params: unknown[] = [workspaceId];
  let where = "WHERE workspace_id = $1";
  if (opts?.category) {
    params.push(opts.category);
    where += ` AND category = $${params.length}`;
  }
  const { rows } = await pool.query<{
    id: string;
    workspace_id: string;
    key: string;
    content: string;
    category: string;
    priority: number;
    added_by: string;
    created_at: Date;
  }>(`SELECT * FROM workspace_shared_context ${where} ORDER BY priority DESC, created_at ASC`, params);

  let entries: SharedContextEntry[] = rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    key: r.key,
    content: r.content,
    category: r.category as SharedContextEntry["category"],
    priority: r.priority,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  }));

  // Truncate from lowest priority if maxTokens specified (rough char-based estimate)
  if (opts?.maxTokens) {
    const tokenLimit = opts.maxTokens;
    let totalChars = 0;
    const kept: SharedContextEntry[] = [];
    for (const entry of entries) {
      // Rough estimate: 1 token ~ 4 chars
      const entryChars = entry.key.length + entry.content.length + 20;
      if (totalChars + entryChars > tokenLimit * 4) break;
      totalChars += entryChars;
      kept.push(entry);
    }
    entries = kept;
  }

  return entries;
}

/** Update content for an existing shared context entry. */
export async function updateSharedContext(
  workspaceId: string,
  key: string,
  content: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE workspace_shared_context SET content = $3, updated_at = now() WHERE workspace_id = $1 AND key = $2`,
    [workspaceId, key, content],
  );
}

/** Remove a shared context entry. */
export async function removeSharedContext(
  workspaceId: string,
  key: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM workspace_shared_context WHERE workspace_id = $1 AND key = $2`,
    [workspaceId, key],
  );
}

/** Build a formatted prompt prefix from shared context entries. */
export function buildSharedContextPrefix(entries: SharedContextEntry[]): string {
  if (entries.length === 0) return "";

  // Group by category
  const grouped = new Map<string, SharedContextEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.category) ?? [];
    existing.push(entry);
    grouped.set(entry.category, existing);
  }

  const lines: string[] = ["## Workspace Knowledge Base"];

  // Category display order
  const categoryOrder = ["knowledge", "decisions", "projects", "general"];
  const categoryLabels: Record<string, string> = {
    knowledge: "Knowledge",
    decisions: "Decisions",
    projects: "Projects",
    general: "General",
  };

  for (const cat of categoryOrder) {
    const catEntries = grouped.get(cat);
    if (!catEntries || catEntries.length === 0) continue;
    lines.push(`### [Category: ${categoryLabels[cat] ?? cat}]`);
    for (const entry of catEntries) {
      lines.push(`- **${entry.key}**: ${entry.content}`);
    }
  }

  return lines.join("\n");
}
