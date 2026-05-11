import type { AgentConfig } from "./types.js";

// ── Agent Constraints ────────────────────────────────────────────────
// Runtime constraints that can be applied on top of an agent's base config.
// These allow callers to further restrict behavior without modifying config.

export interface AgentConstraints {
  /** Maximum spend in USD for this invocation */
  budgetUsd?: number;
  /** Hard deadline — if Date.now() exceeds this, refuse to proceed */
  deadlineMs?: number;
  /** Cap on output tokens — overrides agent config if lower */
  maxTokens?: number;
}

/**
 * Apply runtime constraints onto an agent config, returning a patched copy.
 * Currently handles maxTokens capping. Other fields (budgetUsd, deadlineMs)
 * are enforced separately via checkConstraintBudget().
 */
export function applyConstraints(
  config: AgentConfig,
  constraints: AgentConstraints,
): AgentConfig {
  if (
    constraints.maxTokens !== undefined &&
    constraints.maxTokens < config.model.maxOutputTokens
  ) {
    return {
      ...config,
      model: {
        ...config.model,
        maxOutputTokens: constraints.maxTokens,
      },
    };
  }
  return config;
}

/**
 * Check whether a set of constraints allows the current invocation to proceed.
 * Returns { ok: true } if all checks pass, or { ok: false, reason } on failure.
 */
export function checkConstraintBudget(constraints: AgentConstraints): {
  ok: boolean;
  reason?: string;
} {
  if (
    constraints.deadlineMs !== undefined &&
    Date.now() > constraints.deadlineMs
  ) {
    return { ok: false, reason: "Deadline exceeded" };
  }

  if (constraints.budgetUsd !== undefined && constraints.budgetUsd <= 0) {
    return { ok: false, reason: "Budget exhausted" };
  }

  return { ok: true };
}
