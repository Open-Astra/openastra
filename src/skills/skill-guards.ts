import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { z } from "zod";
import type { ToolContext } from "../tools/types.js";

const logger = createLogger("skill-guards");

// ── Skill Condition Types ───────────────────────────────────────────

export const SkillConditionSchema = z.object({
  id: z.string().uuid().optional(),
  skillId: z.string(),
  agentId: z.string(),
  type: z.enum(["time", "role", "tier", "cost", "custom"]),
  config: z.record(z.string(), z.unknown()),
  isEnabled: z.boolean().default(true),
});

export type SkillCondition = z.infer<typeof SkillConditionSchema>;

export interface GuardEvaluationResult {
  allowed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

// ── Condition Predicates ────────────────────────────────────────────
// Custom predicates for extensibility

const customPredicates = new Map<string, (config: Record<string, unknown>, ctx: ToolContext) => Promise<boolean>>();

export function registerCustomPredicate(
  name: string,
  predicate: (config: Record<string, unknown>, ctx: ToolContext) => Promise<boolean>,
): void {
  customPredicates.set(name, predicate);
}

// ── Evaluate Skill Conditions ───────────────────────────────────────

export async function evaluateSkillConditions(
  skillId: string,
  agentId: string,
  context: ToolContext,
): Promise<GuardEvaluationResult> {
  const pool = getPool();
  const conditions = await pool.query<{
    id: string;
    condition_type: string;
    config: Record<string, unknown>;
  }>(
    `SELECT id, condition_type, config
     FROM skill_conditions
     WHERE skill_id = $1 AND agent_id = $2 AND is_enabled = true`,
    [skillId, agentId],
  );

  if (conditions.rows.length === 0) {
    return { allowed: true };
  }

  const results: { conditionType: string; allowed: boolean; reason?: string }[] = [];

  for (const row of conditions.rows) {
    const condType = row.condition_type as "time" | "role" | "tier" | "cost" | "custom";

    let allowed = true;
    let reason: string | undefined;

    switch (condType) {
      case "time": {
        allowed = await evaluateTimeCondition(row.config);
        if (!allowed) {
          reason = "Skill execution outside allowed time window";
        }
        break;
      }

      case "role": {
        allowed = await evaluateRoleCondition(row.config, context);
        if (!allowed) {
          reason = `User role does not meet requirement: ${row.config.requiredRole}`;
        }
        break;
      }

      case "tier": {
        allowed = await evaluateTierCondition(row.config, context);
        if (!allowed) {
          reason = `Workspace tier does not meet requirement: ${row.config.requiredTier}`;
        }
        break;
      }

      case "cost": {
        allowed = await evaluateCostCondition(row.config, context);
        if (!allowed) {
          reason = `Insufficient budget (required: $${row.config.estimatedCost})`;
        }
        break;
      }

      case "custom": {
        const predicateName = row.config.predicate as string;
        const predicate = customPredicates.get(predicateName);
        if (predicate) {
          allowed = await predicate(row.config, context);
          if (!allowed) {
            reason = `Custom predicate "${predicateName}" returned false`;
          }
        } else {
          logger.warn(`Unknown custom predicate: ${predicateName}`);
          allowed = false;
          reason = `Custom predicate not registered: ${predicateName}`;
        }
        break;
      }
    }

    results.push({ conditionType: condType, allowed, reason });

    // All conditions must pass (AND logic)
    if (!allowed) {
      // Log the evaluation
      await logConditionEvaluation(skillId, agentId, context, row.id, false, reason);

      return {
        allowed: false,
        reason,
        details: { failedCondition: condType, ...row.config },
      };
    }
  }

  // All conditions passed
  await logConditionEvaluation(skillId, agentId, context, conditions.rows[0]?.id, true, undefined);

  return { allowed: true };
}

// ── Condition Evaluators ────────────────────────────────────────────

async function evaluateTimeCondition(config: Record<string, unknown>): Promise<boolean> {
  const allowedHours = config.allowedHours as number[] | undefined;
  if (!allowedHours || allowedHours.length === 0) return true;

  const now = new Date();
  const currentHour = now.getUTCHours();

  // allowedHours: [9, 17] means 9am-5pm UTC
  if (allowedHours.length === 2) {
    const [start, end] = allowedHours;
    return currentHour >= start && currentHour < end;
  }

  return allowedHours.includes(currentHour);
}

async function evaluateRoleCondition(config: Record<string, unknown>, context: ToolContext): Promise<boolean> {
  const requiredRole = config.requiredRole as string | undefined;
  if (!requiredRole) return true;

  const userRole = context.metadata?.userRole as string | undefined;
  if (!userRole) return false;

  // Simple hierarchy: admin > editor > tool_runner > viewer
  const hierarchy: Record<string, number> = {
    admin: 4,
    editor: 3,
    tool_runner: 2,
    viewer: 1,
  };

  const userLevel = hierarchy[userRole] ?? 0;
  const requiredLevel = hierarchy[requiredRole] ?? 0;

  return userLevel >= requiredLevel;
}

async function evaluateTierCondition(config: Record<string, unknown>, context: ToolContext): Promise<boolean> {
  const requiredTier = config.requiredTier as string | undefined;
  if (!requiredTier) return true;

  // Would need to query workspace tier from database
  // For now, check metadata
  const workspaceTier = context.metadata?.workspaceTier as string | undefined;
  if (!workspaceTier) return true; // Default allow if no tier info

  const tierHierarchy: Record<string, number> = {
    free: 1,
    pro: 2,
    enterprise: 3,
  };

  const userTierLevel = tierHierarchy[workspaceTier] ?? 0;
  const requiredTierLevel = tierHierarchy[requiredTier] ?? 0;

  return userTierLevel >= requiredTierLevel;
}

async function evaluateCostCondition(config: Record<string, unknown>, context: ToolContext): Promise<boolean> {
  const estimatedCost = config.estimatedCost as number | undefined;
  if (!estimatedCost) return true;

  const remainingBudget = context.constraints?.budgetUsd ?? Number.POSITIVE_INFINITY;
  return remainingBudget >= estimatedCost;
}

// ── Register Condition ──────────────────────────────────────────────

export async function registerCondition(
  skillId: string,
  agentId: string,
  conditionType: "time" | "role" | "tier" | "cost" | "custom",
  config: Record<string, unknown>,
): Promise<string> {
  const pool = getPool();

  const result = await pool.query<{ id: string }>(
    `INSERT INTO skill_conditions (skill_id, agent_id, condition_type, config)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [skillId, agentId, conditionType, JSON.stringify(config)],
  );

  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`Failed to create condition for skill ${skillId}`);
  }

  logger.info(`Registered condition ${id} for skill ${skillId}:${agentId}`);
  return id;
}

// ── List Skill Conditions ───────────────────────────────────────────

export async function listSkillConditions(skillId: string, agentId?: string): Promise<SkillCondition[]> {
  const pool = getPool();

  let query = `SELECT id, skill_id, agent_id, condition_type, config, is_enabled
               FROM skill_conditions WHERE skill_id = $1`;
  const params: (string | undefined)[] = [skillId];

  if (agentId) {
    query += ` AND agent_id = $2`;
    params.push(agentId);
  }

  query += ` ORDER BY condition_type`;

  const result = await pool.query<{
    id: string;
    skill_id: string;
    agent_id: string;
    condition_type: string;
    config: Record<string, unknown>;
    is_enabled: boolean;
  }>(query, params);

  return result.rows.map((row) => ({
    id: row.id,
    skillId: row.skill_id,
    agentId: row.agent_id,
    type: row.condition_type as "time" | "role" | "tier" | "cost" | "custom",
    config: row.config,
    isEnabled: row.is_enabled,
  }));
}

// ── Update Condition ────────────────────────────────────────────────

export async function updateCondition(
  conditionId: string,
  updates: Partial<{ config: Record<string, unknown>; isEnabled: boolean }>,
): Promise<void> {
  const pool = getPool();

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.config !== undefined) {
    setClauses.push(`config = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(updates.config));
  }

  if (updates.isEnabled !== undefined) {
    setClauses.push(`is_enabled = $${paramIndex++}`);
    values.push(updates.isEnabled);
  }

  if (setClauses.length === 0) return;

  setClauses.push(`updated_at = NOW()`);
  values.push(conditionId);

  const query = `UPDATE skill_conditions SET ${setClauses.join(", ")} WHERE id = $${paramIndex} `;
  await pool.query(query, values);
}

// ── Delete Condition ────────────────────────────────────────────────

export async function deleteCondition(conditionId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM skill_conditions WHERE id = $1`, [conditionId]);
}

// ── Log Condition Evaluation ────────────────────────────────────────

async function logConditionEvaluation(
  skillId: string,
  agentId: string,
  context: ToolContext,
  conditionId: string | undefined,
  allowed: boolean,
  reason: string | undefined,
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO skill_condition_evaluations
       (workspace_id, skill_id, agent_id, uid, session_id, condition_id, allowed, reason, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [context.workspaceId ?? null, skillId, agentId, context.uid, context.sessionId, conditionId ?? null, allowed, reason ?? null],
    );
  } catch (err) {
    logger.warn(`Failed to log condition evaluation`, err);
  }
}
