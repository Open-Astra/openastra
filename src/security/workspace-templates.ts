// ── Workspace Templates ───────────────────────────────────────────────
// Snapshot a workspace config as a reusable template and instantiate from it.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getAllAgentConfigs } from "../config/agents.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("workspace-templates");

export interface WorkspaceTemplate {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  snapshot: WorkspaceSnapshot;
  createdBy: string | null;
  createdAt: Date;
}

export interface WorkspaceSnapshot {
  agents: Array<{
    id: string;
    displayName: string;
    model: { provider: string; modelId: string };
    systemPromptTemplate: string;
    tools: { allow: string[]; deny: string[] };
    skills: string[];
  }>;
  capturedAt: string;
  version: number;
}

/** Capture current workspace configuration into a snapshot. */
export async function snapshotWorkspace(
  _workspaceId: string,
): Promise<WorkspaceSnapshot> {
  const agents = Array.from(getAllAgentConfigs().values());

  return {
    agents: agents.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      model: { provider: a.model.provider, modelId: a.model.modelId },
      systemPromptTemplate: a.systemPromptTemplate,
      tools: { allow: a.tools.allow, deny: a.tools.deny },
      skills: a.skills ?? [],
    })),
    capturedAt: new Date().toISOString(),
    version: 1,
  };
}

export async function saveTemplate(
  workspaceId: string,
  name: string,
  description: string | undefined,
  createdBy: string | undefined,
): Promise<WorkspaceTemplate> {
  const pool = getPool();
  const snapshot = await snapshotWorkspace(workspaceId);
  const id = randomUUID();

  const { rows } = await pool.query<WorkspaceTemplate>(
    `INSERT INTO workspace_templates (id, workspace_id, name, description, snapshot, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, workspace_id AS "workspaceId", name, description,
               snapshot, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, workspaceId, name, description ?? null, JSON.stringify(snapshot), createdBy ?? null],
  );
  logger.info(`Workspace template "${name}" saved (${id})`);
  return rows[0]!;
}

export async function listTemplates(workspaceId: string): Promise<WorkspaceTemplate[]> {
  const pool = getPool();
  const { rows } = await pool.query<WorkspaceTemplate>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            snapshot, created_by AS "createdBy", created_at AS "createdAt"
     FROM workspace_templates WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function getTemplate(id: string, workspaceId: string): Promise<WorkspaceTemplate | null> {
  const pool = getPool();
  const { rows } = await pool.query<WorkspaceTemplate>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            snapshot, created_by AS "createdBy", created_at AS "createdAt"
     FROM workspace_templates WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function deleteTemplate(id: string, workspaceId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM workspace_templates WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}
