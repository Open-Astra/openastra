import { getPool } from "../config/postgres.js";

// ── Dynamic Capability Budgets ──────────────────────────────────────
// Permissions and token budgets are inherited through the swarm tree
// with runtime overrides and hard caps. Each node in the swarm tree
// has a budget that constrains its children.
//
// Budget inheritance: parent budget → child budget (child <= parent)
// Runtime overrides: orchestrator can tighten (never loosen) budgets
// Hard caps: system-level maximums that can't be overridden

// ── Types ───────────────────────────────────────────────────────────

export interface CapabilityBudget {
  // Token limits
  maxPromptTokens: number;
  maxCompletionTokens: number;
  maxTotalTokens: number;
  // Cost limits (in cents)
  maxCostCents: number;
  // Execution limits
  maxToolCalls: number;
  maxDuration: number;         // ms
  maxSpawnDepth: number;
  maxChildAgents: number;
  // Tool permissions
  allowedTools: string[];
  deniedTools: string[];
  // Memory permissions
  canWriteMemory: boolean;
  canReadMemory: boolean;
  canWriteGraph: boolean;
  // Rate limits
  maxRequestsPerMinute: number;
}

export interface BudgetUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  toolCalls: number;
  durationMs: number;
  childAgents: number;
}

export interface BudgetNode {
  nodeId: string;          // agent instance ID
  parentId: string | null;
  roleId: string;
  budget: CapabilityBudget;
  usage: BudgetUsage;
  children: string[];      // child node IDs
  status: "active" | "exhausted" | "revoked";
}

// ── System Hard Caps ────────────────────────────────────────────────
// Maximum values that can't be exceeded regardless of parent budget.

export const SYSTEM_CAPS: CapabilityBudget = {
  maxPromptTokens: 500_000,
  maxCompletionTokens: 100_000,
  maxTotalTokens: 600_000,
  maxCostCents: 500,           // $5 max per swarm
  maxToolCalls: 100,
  maxDuration: 300_000,        // 5 minutes
  maxSpawnDepth: 5,
  maxChildAgents: 20,
  allowedTools: [],            // empty = all allowed
  deniedTools: [],
  canWriteMemory: true,
  canReadMemory: true,
  canWriteGraph: true,
  maxRequestsPerMinute: 30,
};

// ── Default Budgets by Role ─────────────────────────────────────────

export const ROLE_BUDGETS: Record<string, Partial<CapabilityBudget>> = {
  researcher: {
    maxTotalTokens: 50_000,
    maxCostCents: 50,
    maxToolCalls: 20,
    maxDuration: 60_000,
    maxChildAgents: 0,
    canWriteMemory: false,
    canWriteGraph: false,
  },
  analyst: {
    maxTotalTokens: 80_000,
    maxCostCents: 100,
    maxToolCalls: 15,
    maxDuration: 90_000,
    maxChildAgents: 0,
    canWriteMemory: false,
  },
  writer: {
    maxTotalTokens: 30_000,
    maxCostCents: 30,
    maxToolCalls: 5,
    maxDuration: 30_000,
    maxChildAgents: 0,
    canWriteMemory: false,
    canWriteGraph: false,
  },
  mediator: {
    maxTotalTokens: 40_000,
    maxCostCents: 40,
    maxToolCalls: 5,
    maxDuration: 60_000,
    maxChildAgents: 0,
    canWriteMemory: false,
    canWriteGraph: false,
  },
};

// ── Budget Allocation ───────────────────────────────────────────────

export function allocateBudget(
  parentBudget: CapabilityBudget,
  roleId: string,
  overrides: Partial<CapabilityBudget> = {},
): CapabilityBudget {
  const roleDefaults = ROLE_BUDGETS[roleId] ?? {};

  // Start with role defaults, apply overrides, constrain to parent
  const allocated: CapabilityBudget = {
    maxPromptTokens: constrain(
      overrides.maxPromptTokens ?? roleDefaults.maxPromptTokens ?? parentBudget.maxPromptTokens,
      parentBudget.maxPromptTokens,
      SYSTEM_CAPS.maxPromptTokens,
    ),
    maxCompletionTokens: constrain(
      overrides.maxCompletionTokens ?? roleDefaults.maxCompletionTokens ?? parentBudget.maxCompletionTokens,
      parentBudget.maxCompletionTokens,
      SYSTEM_CAPS.maxCompletionTokens,
    ),
    maxTotalTokens: constrain(
      overrides.maxTotalTokens ?? roleDefaults.maxTotalTokens ?? parentBudget.maxTotalTokens,
      parentBudget.maxTotalTokens,
      SYSTEM_CAPS.maxTotalTokens,
    ),
    maxCostCents: constrain(
      overrides.maxCostCents ?? roleDefaults.maxCostCents ?? parentBudget.maxCostCents,
      parentBudget.maxCostCents,
      SYSTEM_CAPS.maxCostCents,
    ),
    maxToolCalls: constrain(
      overrides.maxToolCalls ?? roleDefaults.maxToolCalls ?? parentBudget.maxToolCalls,
      parentBudget.maxToolCalls,
      SYSTEM_CAPS.maxToolCalls,
    ),
    maxDuration: constrain(
      overrides.maxDuration ?? roleDefaults.maxDuration ?? parentBudget.maxDuration,
      parentBudget.maxDuration,
      SYSTEM_CAPS.maxDuration,
    ),
    maxSpawnDepth: Math.min(
      parentBudget.maxSpawnDepth - 1, // each level reduces depth by 1
      SYSTEM_CAPS.maxSpawnDepth,
    ),
    maxChildAgents: constrain(
      overrides.maxChildAgents ?? roleDefaults.maxChildAgents ?? parentBudget.maxChildAgents,
      parentBudget.maxChildAgents,
      SYSTEM_CAPS.maxChildAgents,
    ),
    // Tools: child gets intersection of parent's allowed tools
    allowedTools: intersectTools(
      parentBudget.allowedTools,
      overrides.allowedTools ?? roleDefaults.allowedTools ?? [],
    ),
    deniedTools: unionTools(
      parentBudget.deniedTools,
      overrides.deniedTools ?? roleDefaults.deniedTools ?? [],
    ),
    // Memory: child can only have what parent allows
    canWriteMemory: parentBudget.canWriteMemory &&
      (overrides.canWriteMemory ?? roleDefaults.canWriteMemory ?? true),
    canReadMemory: parentBudget.canReadMemory &&
      (overrides.canReadMemory ?? roleDefaults.canReadMemory ?? true),
    canWriteGraph: parentBudget.canWriteGraph &&
      (overrides.canWriteGraph ?? roleDefaults.canWriteGraph ?? true),
    maxRequestsPerMinute: constrain(
      overrides.maxRequestsPerMinute ?? parentBudget.maxRequestsPerMinute,
      parentBudget.maxRequestsPerMinute,
      SYSTEM_CAPS.maxRequestsPerMinute,
    ),
  };

  return allocated;
}

// ── Budget Checking ─────────────────────────────────────────────────

export function checkBudget(
  budget: CapabilityBudget,
  usage: BudgetUsage,
): { allowed: boolean; reason?: string } {
  if (usage.totalTokens >= budget.maxTotalTokens) {
    return { allowed: false, reason: `Token budget exhausted (${usage.totalTokens}/${budget.maxTotalTokens})` };
  }
  if (usage.costCents >= budget.maxCostCents) {
    return { allowed: false, reason: `Cost budget exhausted ($${(usage.costCents / 100).toFixed(2)}/$${(budget.maxCostCents / 100).toFixed(2)})` };
  }
  if (usage.toolCalls >= budget.maxToolCalls) {
    return { allowed: false, reason: `Tool call limit reached (${usage.toolCalls}/${budget.maxToolCalls})` };
  }
  if (usage.durationMs >= budget.maxDuration) {
    return { allowed: false, reason: `Duration limit reached (${usage.durationMs}ms/${budget.maxDuration}ms)` };
  }
  if (usage.childAgents >= budget.maxChildAgents) {
    return { allowed: false, reason: `Child agent limit reached (${usage.childAgents}/${budget.maxChildAgents})` };
  }
  return { allowed: true };
}

export function isToolAllowed(budget: CapabilityBudget, toolName: string): boolean {
  if (budget.deniedTools.includes(toolName)) return false;
  if (budget.allowedTools.length === 0) return true; // empty = all allowed
  return budget.allowedTools.includes(toolName);
}

// ── Budget Persistence ──────────────────────────────────────────────
// Store budget nodes for audit and real-time monitoring.

export async function persistBudgetNode(
  _uid: string,
  swarmId: string,
  node: BudgetNode,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO budget_nodes (id, swarm_id, agent_id, budget, usage, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET budget = $4::jsonb, usage = $5::jsonb, updated_at = NOW()`,
    [
      node.nodeId,
      swarmId,
      node.roleId,
      JSON.stringify(node.budget),
      JSON.stringify(node.usage),
    ],
  );
}

export async function updateBudgetUsage(
  _uid: string,
  swarmId: string,
  nodeId: string,
  usage: Partial<BudgetUsage>,
): Promise<void> {
  const pool = getPool();

  // Read current usage, merge with partial update, write back
  const { rows } = await pool.query<{ usage: BudgetUsage }>(
    "SELECT usage FROM budget_nodes WHERE id = $1 AND swarm_id = $2",
    [nodeId, swarmId],
  );

  if (rows.length === 0) return;

  const current = rows[0]!.usage;
  const merged = { ...current, ...usage };

  await pool.query(
    "UPDATE budget_nodes SET usage = $1::jsonb, updated_at = NOW() WHERE id = $2 AND swarm_id = $3",
    [JSON.stringify(merged), nodeId, swarmId],
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function constrain(value: number, parentMax: number, systemMax: number): number {
  return Math.min(value, parentMax, systemMax);
}

function intersectTools(parent: string[], child: string[]): string[] {
  if (parent.length === 0) return child; // parent allows all
  if (child.length === 0) return parent; // child allows all (constrained by parent)
  return child.filter((t) => parent.includes(t));
}

function unionTools(parent: string[], child: string[]): string[] {
  return [...new Set([...parent, ...child])];
}

export function createEmptyUsage(): BudgetUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costCents: 0,
    toolCalls: 0,
    durationMs: 0,
    childAgents: 0,
  };
}
