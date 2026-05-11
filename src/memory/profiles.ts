import { z } from "zod";
import { getPool } from "../config/postgres.js";

// ── Schema ───────────────────────────────────────────────────────────

export const MemoryProfileConfigSchema = z.object({
  // Which tiers are enabled (all enabled by default)
  tiersEnabled: z
    .object({
      session: z.boolean().default(true),
      daily: z.boolean().default(true),
      profile: z.boolean().default(true),
      graph: z.boolean().default(true),
      procedural: z.boolean().default(true),
      rag: z.boolean().default(true),
    })
    .default({ session: true, daily: true, profile: true, graph: true, procedural: true, rag: true }),
  // Override global TTL for this profile (days)
  ttlDays: z.number().int().min(1).max(3650).optional(),
  // Max memory chunks returned in context
  maxContextChunks: z.number().int().min(1).max(100).default(20),
  // Minimum relevance score for search results (0-1)
  minRelevanceScore: z.number().min(0).max(1).default(0.5),
  // Extra system prompt injected for this profile
  systemPromptSuffix: z.string().max(2000).optional(),
});

export type MemoryProfileConfig = z.infer<typeof MemoryProfileConfigSchema>;

export interface MemoryProfile {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  config: MemoryProfileConfig;
  createdAt: Date;
  updatedAt: Date;
}

// ── Row mapper ────────────────────────────────────────────────────────

interface ProfileRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  config: unknown;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): MemoryProfile {
  const parsed = MemoryProfileConfigSchema.parse(row.config ?? {});
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    config: parsed,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function createMemoryProfile(
  workspaceId: string,
  name: string,
  description: string | null,
  config: MemoryProfileConfig,
): Promise<MemoryProfile> {
  const pool = getPool();
  const validatedConfig = MemoryProfileConfigSchema.parse(config);
  const { rows } = await pool.query<ProfileRow>(
    `INSERT INTO memory_profiles (workspace_id, name, description, config)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [workspaceId, name, description, JSON.stringify(validatedConfig)],
  );
  return rowToProfile(rows[0]!);
}

export async function listMemoryProfiles(workspaceId: string): Promise<MemoryProfile[]> {
  const pool = getPool();
  const { rows } = await pool.query<ProfileRow>(
    `SELECT * FROM memory_profiles WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId],
  );
  return rows.map(rowToProfile);
}

export async function getMemoryProfile(
  id: string,
  workspaceId: string,
): Promise<MemoryProfile | null> {
  const pool = getPool();
  const { rows } = await pool.query<ProfileRow>(
    `SELECT * FROM memory_profiles WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows.length > 0 ? rowToProfile(rows[0]!) : null;
}

export async function updateMemoryProfile(
  id: string,
  workspaceId: string,
  updates: Partial<{ name: string; description: string | null; config: MemoryProfileConfig }>,
): Promise<MemoryProfile | null> {
  const pool = getPool();

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (Object.prototype.hasOwnProperty.call(updates, "description")) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description ?? null);
  }
  if (updates.config !== undefined) {
    const validatedConfig = MemoryProfileConfigSchema.parse(updates.config);
    fields.push(`config = $${idx++}::jsonb`);
    values.push(JSON.stringify(validatedConfig));
  }

  if (fields.length === 0) {
    return getMemoryProfile(id, workspaceId);
  }

  fields.push(`updated_at = NOW()`);
  values.push(id, workspaceId);

  const { rows } = await pool.query<ProfileRow>(
    `UPDATE memory_profiles SET ${fields.join(", ")}
     WHERE id = $${idx++} AND workspace_id = $${idx}
     RETURNING *`,
    values,
  );
  return rows.length > 0 ? rowToProfile(rows[0]!) : null;
}

export async function deleteMemoryProfile(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM memory_profiles WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function assignAgentProfile(
  agentId: string,
  profileId: string,
  workspaceId: string,
): Promise<void> {
  const pool = getPool();

  // Verify the profile belongs to the caller's workspace before assigning
  const { rows: profileRows } = await pool.query(
    `SELECT id FROM memory_profiles WHERE id = $1 AND workspace_id = $2`,
    [profileId, workspaceId],
  );
  if (profileRows.length === 0) {
    throw new Error(`Profile "${profileId}" not found in workspace`);
  }

  await pool.query(
    `INSERT INTO agent_memory_profiles (agent_id, profile_id)
     VALUES ($1, $2)
     ON CONFLICT (agent_id, profile_id) DO NOTHING`,
    [agentId, profileId],
  );
}

export async function getAgentProfile(agentId: string, workspaceId: string): Promise<MemoryProfile | null> {
  const pool = getPool();
  const { rows } = await pool.query<ProfileRow>(
    `SELECT mp.*
     FROM memory_profiles mp
     INNER JOIN agent_memory_profiles amp ON amp.profile_id = mp.id
     WHERE amp.agent_id = $1 AND mp.workspace_id = $2
     LIMIT 1`,
    [agentId, workspaceId],
  );
  return rows.length > 0 ? rowToProfile(rows[0]!) : null;
}
