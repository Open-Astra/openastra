import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { runAgentLoop, type AgentResponse } from "./loop.js";
import { getRoleCard, roleCardToConfig, listRoleCards } from "./roles.js";
import { writeToBlackboard, readBlackboard, getActiveConflicts, getBlackboardSummary } from "./blackboard.js";
import { recordExecution } from "./ledger.js";
import { allocateBudget, createEmptyUsage, persistBudgetNode, type CapabilityBudget, type BudgetUsage, type BudgetNode } from "./budgets.js";
import { logAgentAction } from "./audit.js";
import { getPool } from "../config/postgres.js";
import { buildContractRetryHint, getOutputContract, validateAgentOutput } from "./output-contracts.js";

// ── Dynamic Hierarchical Swarm Spawning ─────────────────────────────
// For complex tasks, the root agent auto-spawns a tree of specialized
// sub-agents, each instantiated from a typed Role Card.
//
// Swarm lifecycle:
// 1. Plan: Root agent decomposes task into sub-tasks
// 2. Spawn: Sub-agents created from role cards with inherited budgets
// 3. Execute: Sub-agents write to shared blackboard
// 4. Mediate: Conflicts trigger debate protocol
// 5. Synthesize: Root agent assembles final output
// 6. Cleanup: Sessions archived, budgets reconciled

// ── Types ───────────────────────────────────────────────────────────

export interface SwarmConfig {
  maxAgents: number;
  maxDepth: number;
  timeoutMs: number;
  parentBudget: CapabilityBudget;
}

export interface SwarmTask {
  id: string;
  roleId: string;
  description: string;
  dependencies: string[];    // task IDs this depends on
  priority: number;          // higher = run first
}

export interface SwarmAgent {
  instanceId: string;
  roleId: string;
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  budget: CapabilityBudget;
  usage: BudgetUsage;
  response?: AgentResponse;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SwarmState {
  swarmId: string;
  uid: string;
  rootTask: string;
  agents: Map<string, SwarmAgent>;
  tasks: Map<string, SwarmTask>;
  status: "planning" | "executing" | "mediating" | "synthesizing" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
}

export interface SwarmResult {
  swarmId: string;
  content: string;
  agentCount: number;
  totalTokens: number;
  totalDurationMs: number;
  blackboardSummary: string;
}

// ── Swarm Orchestration ─────────────────────────────────────────────

export async function runSwarm(
  uid: string,
  task: string,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  config: SwarmConfig,
): Promise<SwarmResult> {
  const swarmId = randomUUID();
  const start = Date.now();

  console.log(`[swarm] Starting swarm ${swarmId.slice(0, 8)} for uid=${uid}`);

  const state: SwarmState = {
    swarmId,
    uid,
    rootTask: task,
    agents: new Map(),
    tasks: new Map(),
    status: "planning",
    createdAt: start,
  };

  // Persist swarm state
  await persistSwarmState(uid, state);

  try {
    // Phase 1: Plan — decompose task into sub-tasks
    state.status = "planning";
    const tasks = await planTasks(uid, task, inferenceClient, baseConfig);

    for (const t of tasks) {
      state.tasks.set(t.id, t);
    }

    // Phase 2: Execute — spawn sub-agents for each task
    state.status = "executing";
    await persistSwarmState(uid, state);

    // Execute tasks respecting dependencies (topological order)
    const completed = new Set<string>();
    let iterations = 0;
    const maxIterations = tasks.length * 2; // safety valve

    while (completed.size < tasks.length && iterations < maxIterations) {
      iterations++;

      // Find tasks ready to run (dependencies satisfied)
      const ready = tasks.filter(
        (t) =>
          !completed.has(t.id) &&
          t.dependencies.every((dep) => completed.has(dep)),
      );

      if (ready.length === 0 && completed.size < tasks.length) {
        console.error(`[swarm] Deadlock: no ready tasks but ${tasks.length - completed.size} remaining`);
        break;
      }

      // Run ready tasks in parallel
      const results = await Promise.allSettled(
        ready.map((t) =>
          executeSwarmTask(uid, swarmId, t, baseConfig, inferenceClient, config),
        ),
      );

      for (let i = 0; i < ready.length; i++) {
        const taskItem = ready[i]!;
        const result = results[i]!;

        if (result.status === "fulfilled") {
          state.agents.set(result.value.instanceId, result.value);
          completed.add(taskItem.id);

          // Write result to blackboard
          await writeToBlackboard(
            uid,
            swarmId,
            result.value.roleId,
            result.value.instanceId,
            taskItem.roleId, // section = role
            result.value.response?.content ?? "",
          );
        } else {
          console.error(`[swarm] Task ${taskItem.id} failed:`, result.reason);
          completed.add(taskItem.id); // mark as done to avoid deadlock
        }
      }
    }

    // Phase 3: Mediate — resolve any blackboard conflicts
    state.status = "mediating";
    const conflicts = await getActiveConflicts(uid, swarmId);

    if (conflicts.length > 0) {
      console.log(`[swarm] ${conflicts.length} conflict(s) detected, mediating...`);
      await mediateConflicts(uid, swarmId, conflicts, baseConfig, inferenceClient, config);
    }

    // Phase 4: Synthesize — build final output from blackboard
    state.status = "synthesizing";
    const blackboardSummary = await getBlackboardSummary(uid, swarmId);
    const finalContent = await synthesize(uid, task, blackboardSummary, inferenceClient, baseConfig);

    state.status = "completed";
    state.completedAt = Date.now();
    await persistSwarmState(uid, state);

    // Calculate totals
    let totalTokens = 0;
    for (const agent of state.agents.values()) {
      totalTokens += agent.usage.totalTokens;
    }

    const result: SwarmResult = {
      swarmId,
      content: finalContent,
      agentCount: state.agents.size,
      totalTokens,
      totalDurationMs: Date.now() - start,
      blackboardSummary,
    };

    await logAgentAction(uid, baseConfig.id, "swarm_complete", {
      swarmId,
      agentCount: result.agentCount,
      totalTokens: result.totalTokens,
      durationMs: result.totalDurationMs,
    }, result.totalDurationMs);

    console.log(
      `[swarm] ${swarmId.slice(0, 8)} complete: ${result.agentCount} agents, ` +
      `${result.totalTokens} tokens, ${result.totalDurationMs}ms`,
    );

    return result;
  } catch (err) {
    state.status = "failed";
    await persistSwarmState(uid, state);
    throw err;
  }
}

// ── Task Planning ───────────────────────────────────────────────────

async function planTasks(
  _uid: string,
  task: string,
  inferenceClient: InferenceClient,
  _baseConfig: AgentConfig,
): Promise<SwarmTask[]> {
  const roleList = listRoleCards()
    .filter((r) => r.roleId !== "mediator")
    .map((r) => `- ${r.roleId}: ${r.description}`)
    .join("\n");

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are a task planner. Decompose the user's request into 2-5 sub-tasks.
Each sub-task should be assigned to one of these roles:\n${roleList}

Respond in JSON:
[
  {"roleId":"researcher","description":"...","dependencies":[],"priority":1},
  {"roleId":"analyst","description":"...","dependencies":["task-0"],"priority":2}
]

Use "task-N" format for dependency references (0-indexed).
Keep it focused — fewer, better-defined tasks beat many vague ones.`,
      },
      { role: "user", content: task },
    ],
    temperature: 0.3,
    maxTokens: 1500,
  });

  const content = response.content ?? "[]";
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    // Fallback: single researcher task
    return [{
      id: "task-0",
      roleId: "researcher",
      description: task,
      dependencies: [],
      priority: 1,
    }];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      roleId: string;
      description: string;
      dependencies: string[];
      priority: number;
    }>;

    return parsed.map((t, i) => ({
      id: `task-${i}`,
      roleId: t.roleId || "researcher",
      description: t.description,
      dependencies: t.dependencies || [],
      priority: t.priority || i + 1,
    }));
  } catch {
    return [{
      id: "task-0",
      roleId: "researcher",
      description: task,
      dependencies: [],
      priority: 1,
    }];
  }
}

// ── Execute Single Swarm Task ───────────────────────────────────────

async function executeSwarmTask(
  uid: string,
  swarmId: string,
  task: SwarmTask,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  config: SwarmConfig,
): Promise<SwarmAgent> {
  const instanceId = randomUUID();
  const roleCard = getRoleCard(task.roleId);
  const MAX_CONTRACT_RETRIES = 2;

  if (!roleCard) {
    throw new Error(`Unknown role: ${task.roleId}`);
  }

  // Allocate budget for this agent
  const budget = allocateBudget(config.parentBudget, task.roleId);
  const usage = createEmptyUsage();

  const agent: SwarmAgent = {
    instanceId,
    roleId: task.roleId,
    taskId: task.id,
    status: "running",
    budget,
    usage,
    startedAt: Date.now(),
  };

  // Persist budget node
  const budgetNode: BudgetNode = {
    nodeId: instanceId,
    parentId: null,
    roleId: task.roleId,
    budget,
    usage,
    children: [],
    status: "active",
  };
  await persistBudgetNode(uid, swarmId, budgetNode);

  // Build config from role card
  const agentConfig = roleCardToConfig(roleCard, baseConfig);
  const outputContract = roleCard.outputContract ? getOutputContract(roleCard.outputContract) : undefined;

  // Include blackboard context in the task description
  const existingBoard = await readBlackboard(uid, swarmId);
  let baseTaskPrompt = task.description;
  if (existingBoard.length > 0) {
    const boardContext = existingBoard
      .map((e) => `[${e.agentRole}]: ${e.content.slice(0, 500)}`)
      .join("\n");
    baseTaskPrompt += `\n\nContext from other agents:\n${boardContext}`;
  }

  try {
    let response: AgentResponse | undefined;
    let prompt = baseTaskPrompt;
    let attempts = 0;

    while (attempts <= MAX_CONTRACT_RETRIES) {
      response = await Promise.race([
        runAgentLoop(uid, prompt, agentConfig, inferenceClient, {
          uid,
          surface: "prop",
          surfaceId: attempts === 0
            ? `swarm-${swarmId}-${instanceId}`
            : `swarm-${swarmId}-${instanceId}-retry${attempts}`,
        }),
        timeout(roleCard.timeout),
      ]);

      if (!outputContract) {
        break;
      }

      const validation = validateAgentOutput(task.roleId, response.content, outputContract);
      if (validation.valid) {
        break;
      }

      const validationErrors = validation.errors ?? ["Output format invalid"];
      attempts++;

      if (attempts > MAX_CONTRACT_RETRIES) {
        throw new Error(
          `Output contract violation for ${task.roleId}: ${validationErrors.join("; ")}`,
        );
      }

      console.warn(
        `[swarm] Output contract violation for ${task.roleId} (retry ${attempts}): ${validationErrors.join("; ")}`,
      );
      prompt = `${baseTaskPrompt}\n${buildContractRetryHint(outputContract, validationErrors)}`;
    }

    if (!response) {
      throw new Error(`Agent ${task.roleId} did not produce a response`);
    }

    agent.status = "completed";
    agent.response = response;
    agent.completedAt = Date.now();
    agent.usage = {
      ...usage,
      totalTokens: response.tokenUsage.total,
      promptTokens: response.tokenUsage.prompt,
      completionTokens: response.tokenUsage.completion,
      durationMs: Date.now() - (agent.startedAt ?? Date.now()),
      toolCalls: response.toolResults.length,
    };

    // Record in ledger
    await recordExecution({
      roleId: task.roleId,
      swarmId,
      instanceId,
      uid,
      success: true,
      latencyMs: agent.usage.durationMs,
      tokensUsed: agent.usage.totalTokens,
      timestamp: Date.now(),
    });
  } catch (err) {
    agent.status = err instanceof TimeoutError ? "timeout" : "failed";
    agent.error = err instanceof Error ? err.message : String(err);
    agent.completedAt = Date.now();

    await recordExecution({
      roleId: task.roleId,
      swarmId,
      instanceId,
      uid,
      success: false,
      latencyMs: Date.now() - (agent.startedAt ?? Date.now()),
      tokensUsed: agent.usage.totalTokens,
      error: agent.error,
      timestamp: Date.now(),
    });
  }

  return agent;
}

// ── Conflict Mediation ──────────────────────────────────────────────

async function mediateConflicts(
  uid: string,
  swarmId: string,
  conflicts: Array<{ id: string; section: string; entries: string[]; description: string }>,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  _config: SwarmConfig,
): Promise<void> {
  const mediatorCard = getRoleCard("mediator");
  if (!mediatorCard) return;

  for (const conflict of conflicts) {
    const entries = await readBlackboard(uid, swarmId, conflict.section);
    const debateContext = entries
      .map((e) => `**${e.agentRole}** (v${e.version}): ${e.content}`)
      .join("\n\n");

    const mediatorConfig = roleCardToConfig(mediatorCard, baseConfig);
    const mediationTask = `Resolve this conflict:\n${conflict.description}\n\nPositions:\n${debateContext}`;

    try {
      const response = await runAgentLoop(
        uid,
        mediationTask,
        mediatorConfig,
        inferenceClient,
        { uid, surface: "prop", surfaceId: `mediation-${conflict.id}` },
      );

      // Write resolution to blackboard
      await writeToBlackboard(uid, swarmId, "mediator", "mediator", conflict.section, response.content);
    } catch (err) {
      console.error(`[swarm] Mediation failed for conflict ${conflict.id}:`, err);
    }
  }
}

// ── Synthesis ───────────────────────────────────────────────────────

async function synthesize(
  _uid: string,
  originalTask: string,
  blackboardSummary: string,
  inferenceClient: InferenceClient,
  baseConfig: AgentConfig,
): Promise<string> {
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are the synthesis agent. Multiple specialized agents have worked on a task and written their findings to a shared blackboard. Your job is to assemble their work into a cohesive final response for the user. Be direct and actionable.`,
      },
      {
        role: "user",
        content: `Original task: ${originalTask}\n\n${blackboardSummary}\n\nSynthesize the above into a final response.`,
      },
    ],
    temperature: 0.5,
    maxTokens: baseConfig.model.maxOutputTokens,
  });

  return response.content ?? "Unable to synthesize swarm results.";
}

// ── Persistence ─────────────────────────────────────────────────────

async function persistSwarmState(uid: string, state: SwarmState): Promise<void> {
  const pool = getPool();

  const config = {
    rootTask: state.rootTask,
    agents: Object.fromEntries(state.agents),
    tasks: Object.fromEntries(state.tasks),
    completedAt: state.completedAt ?? null,
  };

  await pool.query(
    `INSERT INTO swarms (id, name, owner_id, config, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET config = $4::jsonb, status = $5, updated_at = NOW()`,
    [
      state.swarmId,
      state.rootTask.slice(0, 200),
      uid,
      JSON.stringify(config),
      state.status,
    ],
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new TimeoutError(ms)), ms),
  );
}
