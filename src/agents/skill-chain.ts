// ── Skill Chaining ────────────────────────────────────────────────────
// Compose multiple skills into a named meta-skill with merged tools and context.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { getSkillToolNames, getSkillPromptContext } from "../skills/registry.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("skill-chain");

export interface SkillChain {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  skills: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Merge tool allow-lists from all skills in a chain. */
export function resolveSkillChainTools(skills: string[]): string[] {
  const toolSet = new Set<string>();
  for (const skillId of skills) {
    try {
      for (const tool of getSkillToolNames([skillId])) {
        toolSet.add(tool);
      }
    } catch {
      logger.warn(`Skill "${skillId}" not found — skipping in chain`);
    }
  }
  return [...toolSet];
}

/** Concatenate prompt context from each skill in order. */
export function resolveSkillChainContext(skills: string[]): string {
  return getSkillPromptContext(skills);
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function createSkillChain(
  workspaceId: string,
  name: string,
  skills: string[],
  description?: string,
): Promise<SkillChain> {
  const pool = getPool();
  const id = randomUUID();
  const { rows } = await pool.query<SkillChain>(
    `INSERT INTO skill_chains (id, workspace_id, name, description, skills)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, workspace_id AS "workspaceId", name, description,
               skills, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, workspaceId, name, description ?? null, skills],
  );
  return rows[0]!;
}

export async function listSkillChains(workspaceId: string): Promise<SkillChain[]> {
  const pool = getPool();
  const { rows } = await pool.query<SkillChain>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            skills, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM skill_chains WHERE workspace_id = $1 ORDER BY name ASC`,
    [workspaceId],
  );
  return rows;
}

export async function getSkillChain(id: string, workspaceId: string): Promise<SkillChain | null> {
  const pool = getPool();
  const { rows } = await pool.query<SkillChain>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            skills, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM skill_chains WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function deleteSkillChain(id: string, workspaceId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM skill_chains WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
