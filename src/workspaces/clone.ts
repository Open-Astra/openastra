import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-clone");

export interface CloneOptions {
  includeAgents?: boolean;
  includeMemoryProfiles?: boolean;
  includeSkills?: boolean;
  includeMappings?: boolean;
}

export interface CloneResult {
  newWorkspaceId: string;
  agentsCopied: number;
  profilesCopied: number;
  mappingsCopied: number;
}

export async function cloneWorkspace(
  sourceWorkspaceId: string,
  targetName: string,
  options: CloneOptions = {},
  createdBy: string,
): Promise<CloneResult> {
  const pool = getPool();
  const newWorkspaceId = randomUUID();

  // Create new workspace — workspaces.id is UUID in DB, but we use TEXT UUIDs consistently
  // owner_id references users(id) which is TEXT
  await pool.query(
    `INSERT INTO workspaces (id, name, owner_id, created_at)
     VALUES ($1::uuid, $2, $3, NOW())`,
    [newWorkspaceId, targetName, createdBy],
  );

  let agentsCopied = 0;
  let profilesCopied = 0;
  let mappingsCopied = 0;

  if (options.includeAgents !== false) {
    const agents = await pool.query<{ id: string; config: unknown; display_name: string }>(
      `SELECT id, config, display_name FROM agent_configs WHERE workspace_id = $1`,
      [sourceWorkspaceId],
    );
    for (const agent of agents.rows) {
      const newId = randomUUID();
      await pool.query(
        `INSERT INTO agent_configs (id, workspace_id, display_name, config, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT DO NOTHING`,
        [newId, newWorkspaceId, (agent.display_name ?? "") + " (clone)", JSON.stringify(agent.config)],
      ).catch(() => {});
      agentsCopied++;
    }
  }

  if (options.includeMemoryProfiles) {
    const profiles = await pool.query<{ agent_id: string; config: unknown }>(
      `SELECT agent_id, config FROM memory_profiles WHERE workspace_id = $1`,
      [sourceWorkspaceId],
    );
    for (const profile of profiles.rows) {
      await pool.query(
        `INSERT INTO memory_profiles (workspace_id, agent_id, config, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [newWorkspaceId, profile.agent_id, JSON.stringify(profile.config)],
      ).catch(() => {});
      profilesCopied++;
    }
  }

  if (options.includeMappings) {
    const mappings = await pool.query<{ label_name: string; agent_id: string }>(
      `SELECT label_name, agent_id FROM linear_label_agent_mappings WHERE workspace_id = $1`,
      [sourceWorkspaceId],
    );
    for (const mapping of mappings.rows) {
      await pool.query(
        `INSERT INTO linear_label_agent_mappings (workspace_id, label_name, agent_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [newWorkspaceId, mapping.label_name, mapping.agent_id],
      ).catch(() => {});
      mappingsCopied++;
    }
  }

  log.info(`Cloned workspace ${sourceWorkspaceId} → ${newWorkspaceId} (agents: ${agentsCopied})`);

  return { newWorkspaceId, agentsCopied, profilesCopied, mappingsCopied };
}
