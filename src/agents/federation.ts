import { getPool } from "../config/postgres.js";
import { getAgentConfig } from "../config/agents.js";
import type { AgentConfig } from "./types.js";

// ── Agent Federation ──────────────────────────────────────────────────
// Allows agents from one workspace to be invoked by agents in another
// workspace, subject to explicit grant records in agent_federation_grants.

/**
 * Resolve an agent config that may live in a different workspace.
 * Resolution order:
 *   1. Try local in-memory registry (fast path).
 *   2. Query federation grants to find a granting workspace.
 *   3. Fetch the agent config from agent_configs table.
 *   4. Intersect tools with capabilities.tools if specified.
 *
 * Returns null if the agent cannot be resolved (not found or no valid grant).
 */
export async function resolveAgentAcrossWorkspaces(
  agentId: string,
  requestingWorkspaceId: string,
): Promise<AgentConfig | null> {
  // Fast path — check local registry first
  try {
    return getAgentConfig(agentId);
  } catch {
    // Not in local registry — fall through to federation lookup
  }

  const pool = getPool();

  // Find a valid (non-expired) grant for this agent toward the requesting workspace
  const grantResult = await pool.query<{
    granting_workspace_id: string;
    capabilities: { tools?: string[] };
  }>(
    `SELECT granting_workspace_id, capabilities
     FROM agent_federation_grants
     WHERE receiving_workspace_id = $1
       AND agent_id = $2
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY granted_at DESC
     LIMIT 1`,
    [requestingWorkspaceId, agentId],
  );

  if (grantResult.rows.length === 0) return null;

  const grant = grantResult.rows[0];

  // Fetch the agent config from the granting workspace
  const agentResult = await pool.query<{ config: unknown }>(
    `SELECT config
     FROM agent_configs
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [agentId, grant.granting_workspace_id],
  );

  if (agentResult.rows.length === 0) return null;

  // Parse and validate config
  const { AgentConfig: AgentConfigSchema } = await import("./types.js");
  const parsed = AgentConfigSchema.safeParse(agentResult.rows[0].config);
  if (!parsed.success) return null;

  let federatedConfig = parsed.data;

  // Intersect tools with the grant's capability list if specified
  const allowedTools = grant.capabilities?.tools;
  if (allowedTools && allowedTools.length > 0) {
    federatedConfig = {
      ...federatedConfig,
      tools: {
        ...federatedConfig.tools,
        allow: federatedConfig.tools.allow.filter((t) => allowedTools.includes(t)),
      },
    };
  }

  return federatedConfig;
}
