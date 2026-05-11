import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import { getPool } from "../config/postgres.js";
import { registerAgentConfig, getAgentConfig } from "../config/agents.js";
import { logAgentAction } from "./audit.js";
import { createLogger } from "../utils/logger.js";

// ── Agent Cloning & Forking with Versioned Prompts ──────────────────
// Agents can be cloned (exact copy) or forked (copy + modifications).
// Every system prompt change creates a new version, enabling rollback
// and A/B testing across prompt iterations.
//
// Features:
//   - Clone: exact duplicate with new ID
//   - Fork: clone + apply modifications (prompt, model, skills, tools)
//   - Version history: every prompt change creates a version
//   - Rollback: restore a previous version
//   - Diff: compare two versions
//   - Lineage: track parent → child relationships

const log = createLogger("cloning");

// ── Types ───────────────────────────────────────────────────────────

export interface AgentVersion {
  versionId: string;
  agentId: string;
  version: number;
  systemPrompt: string;
  modelConfig: AgentConfig["model"];
  skills: string[];
  tools: AgentConfig["tools"];
  changelog: string;
  createdAt: number;
  createdBy: string;       // uid of who made the change
}

export interface AgentLineage {
  agentId: string;
  parentId: string | null;
  forkPoint: number | null;  // version number of parent when forked
  createdAt: number;
}

export interface CloneOptions {
  newId?: string;
  displayName?: string;
  changelog?: string;
}

export interface ForkOptions extends CloneOptions {
  systemPromptOverride?: string;
  modelOverrides?: Partial<AgentConfig["model"]>;
  skillsOverride?: string[];
  toolsOverride?: AgentConfig["tools"];
}

// ── Clone Agent ─────────────────────────────────────────────────────

/**
 * Create an exact copy of an agent with a new ID.
 */
export async function cloneAgent(
  sourceAgentId: string,
  uid: string,
  options: CloneOptions = {},
): Promise<AgentConfig> {
  const source = getAgentConfig(sourceAgentId);
  const newId = options.newId ?? `${sourceAgentId}-clone-${randomUUID().slice(0, 8)}`;

  const cloned: AgentConfig = {
    ...source,
    id: newId,
    displayName: options.displayName ?? `${source.displayName} (Clone)`,
  };

  // Register in runtime
  registerAgentConfig(newId, cloned);

  // Persist to database
  await persistAgentConfig(newId, uid, cloned);

  // Record lineage
  await recordLineage(newId, sourceAgentId, await getCurrentVersion(sourceAgentId));

  // Create initial version
  await createVersion(newId, uid, cloned, options.changelog ?? `Cloned from ${sourceAgentId}`);

  await logAgentAction(uid, newId, "agent_clone" as any, {
    sourceAgentId,
    newAgentId: newId,
  });

  log.info(`Cloned ${sourceAgentId} → ${newId}`);
  return cloned;
}

// ── Fork Agent ──────────────────────────────────────────────────────

/**
 * Clone an agent and apply modifications.
 */
export async function forkAgent(
  sourceAgentId: string,
  uid: string,
  options: ForkOptions = {},
): Promise<AgentConfig> {
  const source = getAgentConfig(sourceAgentId);
  const newId = options.newId ?? `${sourceAgentId}-fork-${randomUUID().slice(0, 8)}`;

  const forked: AgentConfig = {
    ...source,
    id: newId,
    displayName: options.displayName ?? `${source.displayName} (Fork)`,
    systemPromptTemplate: options.systemPromptOverride ?? source.systemPromptTemplate,
    model: { ...source.model, ...(options.modelOverrides ?? {}) },
    skills: options.skillsOverride ?? source.skills,
    tools: options.toolsOverride ?? source.tools,
  };

  registerAgentConfig(newId, forked);
  await persistAgentConfig(newId, uid, forked);
  await recordLineage(newId, sourceAgentId, await getCurrentVersion(sourceAgentId));
  await createVersion(newId, uid, forked, options.changelog ?? `Forked from ${sourceAgentId}`);

  await logAgentAction(uid, newId, "agent_fork" as any, {
    sourceAgentId,
    newAgentId: newId,
    modifications: Object.keys(options).filter((k) => k !== "newId" && k !== "displayName" && k !== "changelog"),
  });

  log.info(`Forked ${sourceAgentId} → ${newId}`);
  return forked;
}

// ── Version Management ──────────────────────────────────────────────

/**
 * Create a new version snapshot for an agent.
 */
export async function createVersion(
  agentId: string,
  uid: string,
  config: AgentConfig,
  changelog: string,
): Promise<AgentVersion> {
  const pool = getPool();
  const versionId = randomUUID();
  const versionNum = (await getCurrentVersion(agentId)) + 1;

  const version: AgentVersion = {
    versionId,
    agentId,
    version: versionNum,
    systemPrompt: config.systemPromptTemplate,
    modelConfig: config.model,
    skills: config.skills,
    tools: config.tools,
    changelog,
    createdAt: Date.now(),
    createdBy: uid,
  };

  await pool.query(
    `INSERT INTO agent_versions (id, agent_id, version, config, changelog, created_by, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())`,
    [versionId, agentId, versionNum, JSON.stringify(version), changelog, uid],
  );

  return version;
}

/**
 * Update an agent's system prompt and create a new version.
 */
export async function updateAgentPrompt(
  agentId: string,
  uid: string,
  newPrompt: string,
  changelog: string,
): Promise<AgentVersion> {
  const config = getAgentConfig(agentId);
  const updated = { ...config, systemPromptTemplate: newPrompt };

  registerAgentConfig(agentId, updated);
  await persistAgentConfig(agentId, uid, updated);

  return createVersion(agentId, uid, updated, changelog);
}

/**
 * Rollback an agent to a previous version.
 */
export async function rollbackAgent(
  agentId: string,
  uid: string,
  targetVersion: number,
): Promise<AgentConfig> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: AgentVersion }>(
    "SELECT config FROM agent_versions WHERE agent_id = $1 AND version = $2",
    [agentId, targetVersion],
  );

  if (rows.length === 0) {
    throw new Error(`Version ${targetVersion} not found for agent ${agentId}`);
  }

  const version = rows[0]!.config;
  const currentConfig = getAgentConfig(agentId);

  const restored: AgentConfig = {
    ...currentConfig,
    systemPromptTemplate: version.systemPrompt,
    model: version.modelConfig,
    skills: version.skills,
    tools: version.tools,
  };

  registerAgentConfig(agentId, restored);
  await persistAgentConfig(agentId, uid, restored);
  await createVersion(agentId, uid, restored, `Rolled back to version ${targetVersion}`);

  log.info(`Rolled back ${agentId} to version ${targetVersion}`);
  return restored;
}

/**
 * Get version history for an agent.
 */
export async function getVersionHistory(
  agentId: string,
  limit: number = 20,
): Promise<AgentVersion[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: AgentVersion }>(
    `SELECT config FROM agent_versions
     WHERE agent_id = $1
     ORDER BY version DESC
     LIMIT $2`,
    [agentId, limit],
  );
  return rows.map((r) => r.config);
}

/**
 * Diff two versions of an agent.
 */
export async function diffVersions(
  agentId: string,
  versionA: number,
  versionB: number,
): Promise<{ field: string; a: unknown; b: unknown }[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ version: number; config: AgentVersion }>(
    "SELECT version, config FROM agent_versions WHERE agent_id = $1 AND version IN ($2, $3)",
    [agentId, versionA, versionB],
  );

  if (rows.length !== 2) throw new Error("One or both versions not found");

  const a = rows.find((r) => r.version === versionA)!.config;
  const b = rows.find((r) => r.version === versionB)!.config;

  const diffs: { field: string; a: unknown; b: unknown }[] = [];

  if (a.systemPrompt !== b.systemPrompt) {
    diffs.push({ field: "systemPrompt", a: a.systemPrompt, b: b.systemPrompt });
  }
  if (JSON.stringify(a.modelConfig) !== JSON.stringify(b.modelConfig)) {
    diffs.push({ field: "modelConfig", a: a.modelConfig, b: b.modelConfig });
  }
  if (JSON.stringify(a.skills) !== JSON.stringify(b.skills)) {
    diffs.push({ field: "skills", a: a.skills, b: b.skills });
  }
  if (JSON.stringify(a.tools) !== JSON.stringify(b.tools)) {
    diffs.push({ field: "tools", a: a.tools, b: b.tools });
  }

  return diffs;
}

/**
 * Get lineage (parent chain) for an agent.
 */
export async function getLineage(agentId: string): Promise<AgentLineage[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    agent_id: string;
    parent_id: string | null;
    fork_point: number | null;
    created_at: string;
  }>(
    `WITH RECURSIVE lineage AS (
       SELECT agent_id, parent_id, fork_point, created_at
       FROM agent_lineage WHERE agent_id = $1
       UNION ALL
       SELECT al.agent_id, al.parent_id, al.fork_point, al.created_at
       FROM agent_lineage al
       JOIN lineage l ON al.agent_id = l.parent_id
     )
     SELECT * FROM lineage`,
    [agentId],
  );

  return rows.map((r) => ({
    agentId: r.agent_id,
    parentId: r.parent_id,
    forkPoint: r.fork_point,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

// ── Helpers ─────────────────────────────────────────────────────────

async function getCurrentVersion(agentId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ max: number }>(
    "SELECT COALESCE(MAX(version), 0) as max FROM agent_versions WHERE agent_id = $1",
    [agentId],
  );
  return rows[0]?.max ?? 0;
}

async function persistAgentConfig(agentId: string, uid: string, config: AgentConfig): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_configs (id, owner_id, config, is_active, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, true, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET config = $3::jsonb, updated_at = NOW()`,
    [agentId, uid, JSON.stringify(config)],
  );
}

async function recordLineage(
  agentId: string,
  parentId: string,
  forkPoint: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_lineage (agent_id, parent_id, fork_point, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agent_id) DO NOTHING`,
    [agentId, parentId, forkPoint],
  );
}
