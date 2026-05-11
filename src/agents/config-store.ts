import { getPool } from "../config/postgres.js";
import type { AgentConfig } from "./types.js";
import { registerAgentConfig, unregisterAgentConfig } from "../config/agents.js";

// ── Agent Config Store ──────────────────────────────────────────────
// CRUD for dynamic agent configurations. Persists to Postgres and
// keeps the in-memory runtime registry in sync.

export async function createAgentConfig(
  config: AgentConfig,
  workspaceId: string,
  createdBy: string,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO agent_configs
       (id, workspace_id, display_name, tier, model, system_prompt, tools, skills,
        session_config, spawn_config, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11)`,
    [
      config.id,
      workspaceId,
      config.displayName,
      config.tier,
      JSON.stringify(config.model),
      config.systemPromptTemplate,
      JSON.stringify(config.tools),
      config.skills ?? [],
      JSON.stringify(config.session),
      JSON.stringify(config.spawn),
      createdBy,
    ],
  );

  // Register in runtime map
  registerAgentConfig(config.id, config);

  snapshotAgentVersion(config.id, workspaceId, config, createdBy).catch((err: unknown) => {
    console.error("[config-store] Failed to snapshot initial version:", err);
  });
}

export async function getAgentConfigs(workspaceId: string): Promise<AgentConfig[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM agent_configs WHERE workspace_id = $1 ORDER BY created_at",
    [workspaceId],
  );

  return rows.map(rowToConfig);
}

export async function getAgentConfigById(id: string, workspaceId?: string | null): Promise<AgentConfig | null> {
  const pool = getPool();
  const { rows } = workspaceId
    ? await pool.query(
        "SELECT * FROM agent_configs WHERE id = $1 AND workspace_id = $2",
        [id, workspaceId],
      )
    : await pool.query(
        "SELECT * FROM agent_configs WHERE id = $1",
        [id],
      );

  return rows.length > 0 ? rowToConfig(rows[0]) : null;
}

// ── Cross-Workspace Agent Access (rec 24) ───────────────────────────
// Returns the agent config if the receiving workspace has a valid grant
// from the granting workspace. Null if no grant exists or it is expired.

export async function getGrantedAgentConfig(
  agentId: string,
  receivingWorkspaceId: string,
): Promise<AgentConfig | null> {
  const pool = getPool();

  const { rows: grantRows } = await pool.query<{ granting_workspace_id: string }>(
    `SELECT granting_workspace_id FROM workspace_agent_grants
     WHERE receiving_workspace_id = $1
       AND agent_id = $2
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [receivingWorkspaceId, agentId],
  );

  if (grantRows.length === 0) return null;

  const { rows } = await pool.query(
    "SELECT * FROM agent_configs WHERE id = $1 AND workspace_id = $2",
    [agentId, grantRows[0]!.granting_workspace_id],
  );

  return rows.length > 0 ? rowToConfig(rows[0]) : null;
}

// ── Workspace-Scoped Agent Resolution (rec 24) ──────────────────────
// Full resolution order for the chat route:
//   1. Agent owned by workspaceId            → allowed
//   2. Agent granted to workspaceId          → allowed
//   3. Agent has no workspace row (astra.yml global agent) → allowed
//   4. Agent owned by a different workspace, no grant  → null (403)
//
// When workspaceId is undefined (personal workspace), skip DB checks
// and fall back to the in-memory registry directly.

export async function resolveAgentForWorkspace(
  agentId: string,
  inMemoryConfig: AgentConfig,
  workspaceId: string | undefined,
): Promise<{ config: AgentConfig; source: "owned" | "granted" | "global" } | null> {
  // Personal workspace — no scoping needed
  if (!workspaceId) {
    return { config: inMemoryConfig, source: "global" };
  }

  const pool = getPool();

  // Check if the agent exists in agent_configs at all
  const { rows: dbRows } = await pool.query<{ workspace_id: string | null }>(
    "SELECT workspace_id FROM agent_configs WHERE id = $1",
    [agentId],
  );

  // Agent not in DB at all → it's a global astra.yml agent, always allowed
  if (dbRows.length === 0) {
    return { config: inMemoryConfig, source: "global" };
  }

  const agentWorkspaceId = dbRows[0]!.workspace_id;

  // Agent belongs to this workspace → owned, allowed
  if (agentWorkspaceId === workspaceId) {
    return { config: inMemoryConfig, source: "owned" };
  }

  // Agent belongs to a different workspace → check grants
  const granted = await getGrantedAgentConfig(agentId, workspaceId);
  if (granted) {
    return { config: granted, source: "granted" };
  }

  // No ownership and no grant → deny
  return null;
}

export async function updateAgentConfig(
  id: string,
  updates: Partial<{
    displayName: string;
    tier: string;
    model: AgentConfig["model"];
    systemPromptTemplate: string;
    tools: AgentConfig["tools"];
    skills: string[];
    session: AgentConfig["session"];
    spawn: AgentConfig["spawn"];
  }>,
  updatedBy?: string,
  workspaceId?: string | null,
): Promise<AgentConfig | null> {
  const pool = getPool();

  // Build dynamic SET clause
  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.displayName !== undefined) {
    setClauses.push(`display_name = $${paramIndex++}`);
    values.push(updates.displayName);
  }
  if (updates.tier !== undefined) {
    setClauses.push(`tier = $${paramIndex++}`);
    values.push(updates.tier);
  }
  if (updates.model !== undefined) {
    setClauses.push(`model = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.model));
  }
  if (updates.systemPromptTemplate !== undefined) {
    setClauses.push(`system_prompt = $${paramIndex++}`);
    values.push(updates.systemPromptTemplate);
  }
  if (updates.tools !== undefined) {
    setClauses.push(`tools = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.tools));
  }
  if (updates.skills !== undefined) {
    setClauses.push(`skills = $${paramIndex++}`);
    values.push(updates.skills);
  }
  if (updates.session !== undefined) {
    setClauses.push(`session_config = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.session));
  }
  if (updates.spawn !== undefined) {
    setClauses.push(`spawn_config = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.spawn));
  }

  values.push(id);

  const { rows } = await pool.query(
    `UPDATE agent_configs SET ${setClauses.join(", ")}
     WHERE id = $${paramIndex}${workspaceId ? ` AND workspace_id = $${paramIndex + 1}` : ""}
     RETURNING *`,
    workspaceId ? [...values, workspaceId] : values,
  );

  if (rows.length === 0) return null;

  const config = rowToConfig(rows[0]);
  registerAgentConfig(config.id, config);

  const wsId = rows[0].workspace_id as string | null;
  if (wsId) {
    snapshotAgentVersion(config.id, wsId, config, updatedBy).catch((err: unknown) => {
      console.error("[config-store] Failed to snapshot updated version:", err);
    });
  }

  return config;
}

export async function deleteAgentConfig(id: string, workspaceId?: string | null): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = workspaceId
    ? await pool.query(
        "DELETE FROM agent_configs WHERE id = $1 AND workspace_id = $2",
        [id, workspaceId],
      )
    : await pool.query(
        "DELETE FROM agent_configs WHERE id = $1",
        [id],
      );

  unregisterAgentConfig(id);
  return (rowCount ?? 0) > 0;
}

export async function loadAgentConfigs(workspaceId?: string): Promise<void> {
  const pool = getPool();

  let query: string;
  let params: unknown[];

  if (workspaceId) {
    query = "SELECT * FROM agent_configs WHERE workspace_id = $1";
    params = [workspaceId];
  } else {
    query = "SELECT * FROM agent_configs";
    params = [];
  }

  const { rows } = await pool.query(query, params);

  for (const row of rows) {
    const config = rowToConfig(row);
    registerAgentConfig(config.id, config);
  }

  if (!process.env.ASTRA_STANDALONE) {
    console.log(`[config-store] Loaded ${rows.length} agent config(s) into runtime registry`);
  }
}

// ── Agent Config Versioning ─────────────────────────────────────────

export async function snapshotAgentVersion(
  agentId: string,
  workspaceId: string,
  config: AgentConfig,
  createdBy?: string,
  label?: string,
): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO agent_config_versions (agent_id, workspace_id, version, config, label, created_by)
     VALUES ($1, $2, COALESCE((SELECT MAX(version) FROM agent_config_versions WHERE agent_id = $1), 0) + 1, $3::jsonb, $4, $5)
     RETURNING version`,
    [agentId, workspaceId, JSON.stringify(config), label ?? null, createdBy ?? null],
  );
  return rows[0].version as number;
}

export interface AgentVersionSummary {
  id: string;
  agentId: string;
  version: number;
  label: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export async function listAgentVersions(
  agentId: string,
  workspaceId: string,
): Promise<AgentVersionSummary[]> {
  const { rows } = await getPool().query(
    `SELECT id, agent_id, version, label, created_at, created_by FROM agent_config_versions
     WHERE agent_id = $1 AND workspace_id = $2 ORDER BY version DESC`,
    [agentId, workspaceId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    version: r.version as number,
    label: r.label as string | null,
    createdAt: r.created_at as Date,
    createdBy: r.created_by as string | null,
  }));
}

export async function getAgentVersion(
  agentId: string,
  workspaceId: string,
  version: number,
): Promise<AgentConfig | null> {
  const { rows } = await getPool().query(
    `SELECT config FROM agent_config_versions WHERE agent_id = $1 AND workspace_id = $2 AND version = $3`,
    [agentId, workspaceId, version],
  );
  return rows.length > 0 ? (rows[0].config as AgentConfig) : null;
}

export async function updateVersionLabel(
  agentId: string,
  workspaceId: string,
  version: number,
  label: string | null,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE agent_config_versions SET label = $4 WHERE agent_id = $1 AND workspace_id = $2 AND version = $3`,
    [agentId, workspaceId, version, label],
  );
  return (rowCount ?? 0) > 0;
}

// ── Row Mapper ──────────────────────────────────────────────────────

function rowToConfig(row: Record<string, unknown>): AgentConfig {
  const model = row.model as AgentConfig["model"];
  const tools = row.tools as AgentConfig["tools"];
  const sessionConfig = row.session_config as AgentConfig["session"];
  const spawnConfig = row.spawn_config as AgentConfig["spawn"];

  return {
    id: row.id as string,
    displayName: row.display_name as string,
    tier: row.tier as AgentConfig["tier"],
    model,
    systemPromptTemplate: row.system_prompt as string,
    tools,
    skills: (row.skills as string[]) ?? [],
    session: sessionConfig,
    spawn: spawnConfig,
    fileAccess: { restricted: true, allowedPaths: [] },
  };
}
