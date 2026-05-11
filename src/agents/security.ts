import type { AgentConfig } from "./types.js";
import { getAgentConfig } from "../config/agents.js";

// ── Inter-Agent Security Layer ─────────────────────────────────────
// Pure functions that enforce spawn policies, tool inheritance, and
// inter-agent messaging rules. Called by the spawn manager and agent
// loop — no Firestore dependency, fully testable in isolation.

// ── Spawn Validation ───────────────────────────────────────────────
// Before an agent spawns a sub-agent, we validate:
//   1. The parent has spawning enabled
//   2. The target agent is in the parent's allowedTargets
//   3. The current depth hasn't exceeded the parent's maxDepth

export interface SpawnValidation {
  valid: boolean;
  reason?: string;
}

export function validateSpawn(
  parentConfig: AgentConfig,
  targetAgentId: string,
  depth: number,
): SpawnValidation {
  if (!parentConfig.spawn.enabled) {
    return {
      valid: false,
      reason: `Agent "${parentConfig.id}" does not have spawning enabled.`,
    };
  }

  const allowed = parentConfig.spawn.allowedTargets as string[];
  if (!allowed.includes(targetAgentId)) {
    return {
      valid: false,
      reason: `Agent "${parentConfig.id}" is not allowed to spawn "${targetAgentId}". Allowed targets: [${allowed.join(", ")}].`,
    };
  }

  if (depth >= parentConfig.spawn.maxDepth) {
    return {
      valid: false,
      reason: `Spawn depth ${depth} exceeds max depth ${parentConfig.spawn.maxDepth} for agent "${parentConfig.id}".`,
    };
  }

  return { valid: true };
}

// ── Tool Inheritance ───────────────────────────────────────────────
// Sub-agents can never have MORE tools than their parent. The resolved
// tool set is the intersection of the parent's and target's allow lists.
// This enforces privilege de-escalation down the spawn chain.

export function resolveInheritedTools(
  parentAllow: string[],
  targetAllow: string[],
): string[] {
  const parentSet = new Set(parentAllow);
  return targetAllow.filter((tool) => parentSet.has(tool));
}

// ── Message Validation ─────────────────────────────────────────────
// Dynamic lookup: uses each agent's spawn.allowedTargets to determine
// if inter-agent messaging is permitted. No hardcoded allowlist.

export function validateAgentMessage(
  fromAgentId: string,
  toAgentId: string,
): boolean {
  try {
    const config = getAgentConfig(fromAgentId);
    return config.spawn.allowedTargets.includes(toAgentId);
  } catch {
    return false;
  }
}
