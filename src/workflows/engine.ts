import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("workflow-engine");

// ── Types ────────────────────────────────────────────────────────────

export type ResolveClientFn = (config: AgentConfig) => InferenceClient;

export interface AgentStep {
  id: string;
  type: "agent";
  agentId: string;
  message: string;
  outputVar: string;
}

export interface ToolStep {
  id: string;
  type: "tool";
  toolName: string;
  params: Record<string, unknown>;
  outputVar: string;
}

export interface ConditionStep {
  id: string;
  type: "condition";
  expr: string; // evaluated against context vars, e.g. "{{result}} !== ''"
  then: string; // stepId to jump to if true
  else: string; // stepId to jump to if false
}

export interface ParallelStep {
  id: string;
  type: "parallel";
  steps: WorkflowStep[];
}

export type WorkflowStep = AgentStep | ToolStep | ConditionStep | ParallelStep;

export interface WorkflowDefinition {
  steps: WorkflowStep[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  uid: string;
  input: Record<string, unknown>;
}

export interface WorkflowOutput {
  runId: string;
  status: "completed" | "failed";
  vars: Record<string, unknown>;
  error?: string;
  stepCount: number;
  durationMs: number;
}

// The run (who started it, in which workspace) is carried to every step so
// tool steps execute as that user under normal tool policy.
const runStore = new AsyncLocalStorage<WorkflowRun>();

// ── Engine ───────────────────────────────────────────────────────────

export async function executeWorkflow(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  resolveClient: ResolveClientFn,
): Promise<WorkflowOutput> {
  const start = Date.now();
  const vars: Record<string, unknown> = { ...run.input };
  let stepCount = 0;

  // Build a step map for O(1) lookup (used by condition jumps)
  const stepMap = new Map<string, WorkflowStep>();
  for (const step of definition.steps) {
    stepMap.set(step.id, step);
  }

  try {
    // Linear execution with condition-based jumps
    const executionOrder = buildExecutionOrder(definition.steps, stepMap, vars);
    await runStore.run(run, async () => {
      for (const step of executionOrder) {
        await executeStep(step, vars, resolveClient, stepMap);
        stepCount++;
      }
    });

    return {
      runId: run.id,
      status: "completed",
      vars,
      stepCount,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`Workflow run ${run.id} failed: ${error}`);
    return {
      runId: run.id,
      status: "failed",
      vars,
      error,
      stepCount,
      durationMs: Date.now() - start,
    };
  }
}

// ── Step Execution ───────────────────────────────────────────────────

async function executeStep(
  step: WorkflowStep,
  vars: Record<string, unknown>,
  resolveClient: ResolveClientFn,
  stepMap: Map<string, WorkflowStep>,
): Promise<void> {
  switch (step.type) {
    case "agent":
      await executeAgentStep(step, vars, resolveClient);
      break;
    case "tool":
      await executeToolStep(step, vars);
      break;
    case "condition":
      // Condition steps are handled in buildExecutionOrder — skip here
      break;
    case "parallel":
      await executeParallelStep(step, vars, resolveClient, stepMap);
      break;
  }
}

async function executeAgentStep(
  step: AgentStep,
  vars: Record<string, unknown>,
  resolveClient: ResolveClientFn,
): Promise<void> {
  const { getAgentConfig } = await import("../config/agents.js");
  const agentConfig = getAgentConfig(step.agentId);
  const client = resolveClient(agentConfig);

  // Interpolate message with vars
  const message = interpolate(step.message, vars);

  const response = await client.chat({
    messages: [
      { role: "system", content: agentConfig.systemPromptTemplate },
      { role: "user", content: message },
    ],
    temperature: agentConfig.model.temperature,
    maxTokens: agentConfig.model.maxOutputTokens,
    sessionId: randomUUID(),
  });

  vars[step.outputVar] = response.content ?? "";
  logger.info(`[workflow] agent step ${step.id} -> ${step.outputVar} set`);
}

async function executeToolStep(
  step: ToolStep,
  vars: Record<string, unknown>,
): Promise<void> {
  const { getTool, executeTool } = await import("../tools/registry.js");
  const { getToolRiskLevel } = await import("../tools/risk-levels.js");
  const tool = getTool(step.toolName);
  if (!tool) {
    throw new Error(`Workflow tool step "${step.id}": tool not found: ${step.toolName}`);
  }

  const run = runStore.getStore();
  if (!run?.uid) {
    throw new Error(`Workflow tool step "${step.id}": no authenticated run context`);
  }

  // Outside a workspace there is no role to check, so only low-risk tools
  // may run. Inside a workspace executeTool() applies role-based access.
  const risk = getToolRiskLevel(step.toolName);
  if (!run.workspaceId && risk !== "READ_ONLY" && risk !== "SAFE") {
    throw new Error(
      `Workflow tool step "${step.id}": tool "${step.toolName}" (${risk}) requires a workspace context`,
    );
  }

  // Interpolate vars into string values of the params structure. (Never
  // into the serialized JSON: a variable containing quotes could otherwise
  // inject additional parameters.)
  const interpolatedParams = deepInterpolate(step.params, vars);

  // Go through executeTool(): the caller's effective allow/deny policy
  // (when the workflow was started by an agent), RBAC, rate limits, guards
  // and the approval gate all apply. The step runs as the user who started
  // the run — not as an anonymous "workflow" principal.
  const result = await executeTool(
    { id: randomUUID(), name: step.toolName, arguments: JSON.stringify(interpolatedParams) },
    {
      uid: run.uid,
      agentId: "workflow",
      sessionId: `workflow:${run.id}`,
      workspaceId: run.workspaceId || undefined,
    },
    new Set([step.toolName]),
  );
  if (result.error) {
    throw new Error(`Workflow tool step "${step.id}" failed: ${result.error}`);
  }

  let value: unknown = result.content;
  try {
    value = JSON.parse(result.content);
  } catch { /* keep raw content */ }

  vars[step.outputVar] = value;
  logger.info(`[workflow] tool step ${step.id} -> ${step.outputVar} set`);
}

function deepInterpolate(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((v) => deepInterpolate(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepInterpolate(v, vars);
    }
    return out;
  }
  return value;
}

async function executeParallelStep(
  step: ParallelStep,
  vars: Record<string, unknown>,
  resolveClient: ResolveClientFn,
  stepMap: Map<string, WorkflowStep>,
): Promise<void> {
  await Promise.all(
    step.steps.map((s) => executeStep(s, vars, resolveClient, stepMap)),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Builds a flat execution list. Condition steps are evaluated inline
 * and the appropriate branch's steps are inserted instead of a jump.
 */
function buildExecutionOrder(
  steps: WorkflowStep[],
  stepMap: Map<string, WorkflowStep>,
  vars: Record<string, unknown>,
): WorkflowStep[] {
  const result: WorkflowStep[] = [];
  const visited = new Set<string>();

  function process(step: WorkflowStep) {
    if (visited.has(step.id)) return;
    visited.add(step.id);

    if (step.type === "condition") {
      const conditionMet = evaluateCondition(step.expr, vars);
      const targetId = conditionMet ? step.then : step.else;
      const target = stepMap.get(targetId);
      if (target) process(target);
    } else {
      result.push(step);
    }
  }

  for (const step of steps) {
    process(step);
  }

  return result;
}

function evaluateCondition(expr: string, vars: Record<string, unknown>): boolean {
  try {
    // Simple interpolation-based evaluation — not eval()
    const interpolated = interpolate(expr, vars);
    // Check for truthy non-empty interpolated result
    return interpolated !== "" && interpolated !== "false" && interpolated !== "null" && interpolated !== "undefined";
  } catch {
    return false;
  }
}

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = vars[key];
    return val !== undefined && val !== null ? String(val) : "";
  });
}
