import { randomUUID } from "node:crypto";
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
    for (const step of executionOrder) {
      await executeStep(step, vars, resolveClient, stepMap);
      stepCount++;
    }

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
  const { getTool } = await import("../tools/registry.js");
  const tool = getTool(step.toolName);
  if (!tool) {
    throw new Error(`Workflow tool step "${step.id}": tool not found: ${step.toolName}`);
  }

  // Interpolate params with current vars
  const interpolatedParams = JSON.parse(interpolate(JSON.stringify(step.params), vars));
  const parsed = tool.parameters.parse(interpolatedParams);
  const result = await tool.execute(parsed, {
    uid: "workflow",
    agentId: "workflow",
    sessionId: randomUUID(),
  });

  vars[step.outputVar] = result;
  logger.info(`[workflow] tool step ${step.id} -> ${step.outputVar} set`);
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
