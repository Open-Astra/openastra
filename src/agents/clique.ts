// ── Agent Clique Formation ─────────────────────────────────────────────
// Dynamically assembles ad-hoc agent teams from capability graph.
// A clique has a coordinator agent that delegates to members.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { getAllAgentConfigs } from "../config/agents.js";
import { getSkillToolNames } from "../skills/registry.js";

const logger = createLogger("clique");

export interface AgentClique {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  agentIds: string[];
  coordinatorAgentId: string;
  status: "idle" | "running" | "dissolved";
  createdBy: string | null;
  createdAt: Date;
}

export interface CliqueRun {
  id: string;
  cliqueId: string;
  task: string;
  result: string | null;
  status: "pending" | "running" | "done" | "failed";
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** Pick agents whose combined capabilities cover all required tools/skills. */
export function formCliqueFromCapabilities(
  requiredTools: string[],
  requiredSkills: string[],
  maxSize = 5,
): string[] {
  const allConfigs = Array.from(getAllAgentConfigs().values());
  const selected: string[] = [];
  const covered = new Set<string>();

  // Greedy: pick agents that add the most uncovered capabilities
  const candidates = allConfigs.map((cfg) => {
    const skillTools = getSkillToolNames(cfg.skills ?? []);
    const tools = new Set([...cfg.tools.allow, ...skillTools]);
    return { id: cfg.id, tools, skills: new Set(cfg.skills ?? []) };
  });

  const needed = new Set([...requiredTools, ...requiredSkills]);

  while (covered.size < needed.size && selected.length < maxSize) {
    let bestIdx = -1;
    let bestGain = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (selected.includes(candidates[i]!.id)) continue;
      const c = candidates[i]!;
      const gain = [...needed].filter((n) => c.tools.has(n) || c.skills.has(n)).filter((n) => !covered.has(n)).length;
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    const best = candidates[bestIdx]!;
    selected.push(best.id);
    best.tools.forEach((t) => covered.add(t));
    best.skills.forEach((s) => covered.add(s));
  }

  return selected;
}

export async function createClique(
  workspaceId: string,
  name: string,
  agentIds: string[],
  coordinatorAgentId: string,
  createdBy?: string,
  description?: string,
): Promise<AgentClique> {
  const id = randomUUID();
  const { rows } = await getPool().query<AgentClique>(
    `INSERT INTO agent_cliques
       (id, workspace_id, name, description, agent_ids, coordinator_agent_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, workspace_id AS "workspaceId", name, description,
               agent_ids AS "agentIds", coordinator_agent_id AS "coordinatorAgentId",
               status, created_by AS "createdBy", created_at AS "createdAt"`,
    [id, workspaceId, name, description ?? null, agentIds, coordinatorAgentId, createdBy ?? null],
  );
  logger.info(`Clique "${name}" created with ${agentIds.length} agents`);
  return rows[0]!;
}

export async function listCliques(workspaceId: string): Promise<AgentClique[]> {
  const { rows } = await getPool().query<AgentClique>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            agent_ids AS "agentIds", coordinator_agent_id AS "coordinatorAgentId",
            status, created_by AS "createdBy", created_at AS "createdAt"
     FROM agent_cliques WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function getClique(id: string, workspaceId: string): Promise<AgentClique | null> {
  const { rows } = await getPool().query<AgentClique>(
    `SELECT id, workspace_id AS "workspaceId", name, description,
            agent_ids AS "agentIds", coordinator_agent_id AS "coordinatorAgentId",
            status, created_by AS "createdBy", created_at AS "createdAt"
     FROM agent_cliques WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function dissolveClique(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE agent_cliques SET status = 'dissolved', dissolved_at = NOW()
     WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function createCliqueRun(cliqueId: string, task: string): Promise<CliqueRun> {
  const id = randomUUID();
  const { rows } = await getPool().query<CliqueRun>(
    `INSERT INTO clique_runs (id, clique_id, task)
     VALUES ($1, $2, $3)
     RETURNING id, clique_id AS "cliqueId", task, result, status,
               started_at AS "startedAt", finished_at AS "finishedAt",
               created_at AS "createdAt"`,
    [id, cliqueId, task],
  );
  return rows[0]!;
}

export async function updateCliqueRun(
  id: string,
  status: CliqueRun["status"],
  result?: string,
): Promise<void> {
  await getPool().query(
    `UPDATE clique_runs SET status = $2, result = $3,
       started_at = CASE WHEN $2 = 'running' THEN NOW() ELSE started_at END,
       finished_at = CASE WHEN $2 IN ('done','failed') THEN NOW() ELSE finished_at END
     WHERE id = $1`,
    [id, status, result ?? null],
  );
}
