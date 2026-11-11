import type { AgentConfig } from "../agents/types.js";
import { getAgentConfig } from "../config/agents.js";
import { resolveAgentForWorkspace } from "../agents/config-store.js";
import { getMemberRole } from "../workspaces/store.js";
import { getPool } from "../config/postgres.js";
import { checkTokenBudget } from "../billing/budget-check.js";
import { createLogger } from "../utils/logger.js";

// ── Agent Run Authorization ─────────────────────────────────────────
// One place that decides whether `uid` may run `agentId` in a given
// workspace scope. Used by every transport that can start an agent turn
// (HTTP chat, /ws, /playground/ws) so they cannot drift apart:
//
//   1. agent exists
//   2. caller is a member of the workspace (when one is given) and is not
//      a read-only viewer
//   3. agent is owned by / granted to that workspace, or is a global agent
//      (no workspace → global agents only)
//   4. workspace allowed_providers / allowed_models
//   5. per-user token budget (hard cap blocks, soft cap downgrades model)

const log = createLogger("agent-access");

export type AgentRunDecision =
  | { ok: true; config: AgentConfig }
  | { ok: false; status: number; message: string };

/** Enforce workspaces.allowed_providers / allowed_models. Null = allowed. */
export async function checkWorkspaceModelPolicy(
  workspaceId: string,
  model: AgentConfig["model"],
): Promise<string | null> {
  const { rows } = await getPool().query<{
    allowed_providers: string[] | null;
    allowed_models: string[] | null;
  }>(
    "SELECT allowed_providers, allowed_models FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  const r = rows[0];
  if (r?.allowed_providers && !r.allowed_providers.includes(model.provider)) {
    return `Provider "${model.provider}" is not allowed in this workspace`;
  }
  if (r?.allowed_models && !r.allowed_models.includes(model.modelId)) {
    return `Model "${model.modelId}" is not allowed in this workspace`;
  }
  return null;
}

export async function authorizeAgentRun(
  uid: string,
  agentId: string,
  workspaceId: string | null | undefined,
  opts: { enforceBudget?: boolean } = {},
): Promise<AgentRunDecision> {
  let baseConfig: AgentConfig;
  try {
    baseConfig = getAgentConfig(agentId);
  } catch {
    return { ok: false, status: 404, message: `Agent "${agentId}" not found` };
  }

  try {
    if (workspaceId) {
      const role = await getMemberRole(workspaceId, uid);
      if (!role) {
        return { ok: false, status: 403, message: "Not a member of this workspace" };
      }
      if (role === "viewer") {
        return { ok: false, status: 403, message: "Viewers cannot run agents" };
      }
    }

    const resolved = await resolveAgentForWorkspace(agentId, baseConfig, workspaceId ?? null);
    if (!resolved) {
      // 404 rather than 403 so agent ids of other tenants cannot be enumerated
      return { ok: false, status: 404, message: `Agent "${agentId}" not found` };
    }
    let config = resolved.config;

    if (workspaceId) {
      const denied = await checkWorkspaceModelPolicy(workspaceId, config.model);
      if (denied) return { ok: false, status: 403, message: denied };
    }

    if (opts.enforceBudget !== false) {
      const budget = await checkTokenBudget(uid);
      if (!budget.allowed) {
        return { ok: false, status: 429, message: "Token budget exceeded" };
      }
      if (budget.degraded && budget.overrideModel) {
        config = { ...config, model: { ...config.model, modelId: budget.overrideModel } };
      }
    }

    return { ok: true, config };
  } catch (err) {
    // Fail closed — an authorization error must never grant access
    log.error("Agent run authorization failed:", err);
    return { ok: false, status: 503, message: "Unable to authorize agent run" };
  }
}
