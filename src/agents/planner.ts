import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { runSwarm, type SwarmConfig, type SwarmResult } from "./swarm.js";
import { SYSTEM_CAPS, type CapabilityBudget } from "./budgets.js";
import { getRoleCard, listRoleCards, type RoleCard } from "./roles.js";
import { logAgentAction } from "./audit.js";
import { getPool } from "../config/postgres.js";

// ── Auto-Swarm Planner ─────────────────────────────────────────────
// The root agent decomposes a complex user request into a dependency
// tree of sub-tasks, selects optimal roles for each, and spawns a
// full swarm tree with proper budget allocation.
//
// Three planning strategies:
//   1. LLM-planned: LLM decides task decomposition and roles
//   2. Template-planned: predefined pipelines for known task types
//   3. Adaptive: starts with template, refines with LLM

// ── Types ───────────────────────────────────────────────────────────

export interface PlanNode {
  id: string;
  roleId: string;
  description: string;
  dependencies: string[];
  priority: number;
  budgetOverrides?: Partial<CapabilityBudget>;
  expectedOutputType: "research" | "analysis" | "synthesis" | "validation";
}

export interface SwarmPlan {
  planId: string;
  strategy: "llm" | "template" | "adaptive";
  nodes: PlanNode[];
  estimatedTokens: number;
  estimatedCostCents: number;
  estimatedDurationMs: number;
  parallelismFactor: number; // how many tasks can run concurrently
}

export interface PlanTemplate {
  id: string;
  name: string;
  triggerPatterns: RegExp[];
  nodes: Omit<PlanNode, "id" | "description">[];
  descriptionTemplate: (task: string) => string[];
}

// ── Built-in Templates ──────────────────────────────────────────────

const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: "research-and-summarize",
    name: "Research & Summarize",
    triggerPatterns: [
      /research\b/i, /find out\b/i, /what do we know/i,
      /look into\b/i, /investigate\b/i,
    ],
    nodes: [
      { roleId: "researcher", dependencies: [], priority: 1, expectedOutputType: "research" },
      { roleId: "writer", dependencies: ["task-0"], priority: 2, expectedOutputType: "synthesis" },
    ],
    descriptionTemplate: (task) => [
      `Research the following: ${task}`,
      `Synthesize the research into a clear summary for the user.`,
    ],
  },
  {
    id: "analyze-and-validate",
    name: "Analyze & Validate",
    triggerPatterns: [
      /analyze\b/i, /compare\b/i, /evaluate\b/i,
      /should I\b/i, /which is better/i,
    ],
    nodes: [
      { roleId: "researcher", dependencies: [], priority: 1, expectedOutputType: "research" },
      { roleId: "analyst", dependencies: ["task-0"], priority: 2, expectedOutputType: "analysis" },
      { roleId: "validator", dependencies: ["task-1"], priority: 3, expectedOutputType: "validation" },
      { roleId: "writer", dependencies: ["task-1", "task-2"], priority: 4, expectedOutputType: "synthesis" },
    ],
    descriptionTemplate: (task) => [
      `Gather all relevant data for: ${task}`,
      `Perform quantitative analysis on the gathered data.`,
      `Cross-check the analysis for accuracy and consistency.`,
      `Write a final recommendation based on the validated analysis.`,
    ],
  },
  {
    id: "deep-dive",
    name: "Deep Dive",
    triggerPatterns: [
      /deep dive/i, /comprehensive\b/i, /thorough\b/i,
      /in-depth\b/i, /everything about/i,
    ],
    nodes: [
      { roleId: "researcher", dependencies: [], priority: 1, expectedOutputType: "research" },
      { roleId: "researcher", dependencies: [], priority: 1, expectedOutputType: "research" },
      { roleId: "analyst", dependencies: ["task-0", "task-1"], priority: 2, expectedOutputType: "analysis" },
      { roleId: "validator", dependencies: ["task-2"], priority: 3, expectedOutputType: "validation" },
      { roleId: "writer", dependencies: ["task-2", "task-3"], priority: 4, expectedOutputType: "synthesis" },
    ],
    descriptionTemplate: (task) => [
      `Research primary sources for: ${task}`,
      `Research secondary/alternative perspectives for: ${task}`,
      `Cross-reference both research tracks and identify key patterns.`,
      `Validate the analysis against available data.`,
      `Write a comprehensive report combining all findings.`,
    ],
  },
];

// ── Plan Generation ─────────────────────────────────────────────────

/**
 * Generate a swarm plan using the specified strategy.
 */
export async function generatePlan(
  task: string,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  strategy: SwarmPlan["strategy"] = "adaptive",
): Promise<SwarmPlan> {
  const planId = randomUUID();

  if (strategy === "template" || strategy === "adaptive") {
    const template = matchTemplate(task);
    if (template) {
      const plan = templateToPlan(planId, template, task);
      if (strategy === "template") return plan;
      // Adaptive: refine the template plan with LLM
      return refinePlanWithLLM(plan, task, inferenceClient, baseConfig);
    }
  }

  // LLM-planned (or adaptive fallback)
  return llmPlan(planId, task, inferenceClient, baseConfig);
}

/**
 * Execute a generated plan as a swarm.
 */
export async function executePlan(
  uid: string,
  plan: SwarmPlan,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<SwarmResult> {
  const start = Date.now();

  await logAgentAction(uid, baseConfig.id, "swarm_plan_execute", {
    planId: plan.planId,
    strategy: plan.strategy,
    nodeCount: plan.nodes.length,
    estimatedTokens: plan.estimatedTokens,
  });

  // Persist the plan
  await persistPlan(uid, plan);

  // Convert plan nodes to the swarm task format and run
  const swarmConfig: SwarmConfig = {
    maxAgents: plan.nodes.length + 2, // +2 for mediator + synthesis
    maxDepth: 3,
    timeoutMs: plan.estimatedDurationMs * 1.5, // 50% buffer
    parentBudget: SYSTEM_CAPS,
  };

  const result = await runSwarm(uid, formatPlanAsTask(plan), baseConfig, inferenceClient, swarmConfig);

  await logAgentAction(uid, baseConfig.id, "swarm_plan_complete", {
    planId: plan.planId,
    durationMs: Date.now() - start,
    agentCount: result.agentCount,
    totalTokens: result.totalTokens,
  }, Date.now() - start);

  return result;
}

/**
 * One-shot: generate plan and execute immediately.
 */
export async function planAndExecute(
  uid: string,
  task: string,
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  strategy: SwarmPlan["strategy"] = "adaptive",
): Promise<SwarmResult> {
  const plan = await generatePlan(task, baseConfig, inferenceClient, strategy);
  return executePlan(uid, plan, baseConfig, inferenceClient);
}

// ── Template Matching ───────────────────────────────────────────────

function matchTemplate(task: string): PlanTemplate | undefined {
  for (const template of PLAN_TEMPLATES) {
    if (template.triggerPatterns.some((p) => p.test(task))) {
      return template;
    }
  }
  return undefined;
}

function templateToPlan(planId: string, template: PlanTemplate, task: string): SwarmPlan {
  const descriptions = template.descriptionTemplate(task);
  const nodes: PlanNode[] = template.nodes.map((n, i) => ({
    ...n,
    id: `task-${i}`,
    description: descriptions[i] ?? task,
  }));

  // Estimate costs
  const roleCards = nodes.map((n) => getRoleCard(n.roleId)).filter(Boolean) as RoleCard[];
  const estimatedTokens = roleCards.reduce((sum, r) => sum + r.maxTokens * 2, 0); // prompt + completion
  const estimatedDurationMs = roleCards.reduce((sum, r) => sum + r.timeout, 0);

  // Count max parallelism
  const depthMap = new Map<number, number>();
  for (const node of nodes) {
    const depth = node.dependencies.length === 0 ? 0 : Math.max(...node.dependencies.map((d) => {
      const depNode = nodes.find((n) => n.id === d);
      return depNode ? depNode.priority : 0;
    }));
    depthMap.set(depth, (depthMap.get(depth) ?? 0) + 1);
  }
  const parallelismFactor = Math.max(...depthMap.values(), 1);

  return {
    planId,
    strategy: "template",
    nodes,
    estimatedTokens,
    estimatedCostCents: Math.ceil(estimatedTokens / 1000 * 0.3), // rough estimate
    estimatedDurationMs,
    parallelismFactor,
  };
}

// ── LLM-Based Planning ──────────────────────────────────────────────

async function llmPlan(
  planId: string,
  task: string,
  inferenceClient: InferenceClient,
  _baseConfig: AgentConfig,
): Promise<SwarmPlan> {
  const availableRoles = listRoleCards().map((r) => ({
    roleId: r.roleId,
    name: r.name,
    description: r.description,
    tools: r.tools,
  }));

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are a swarm planner. Decompose the user's task into a dependency tree of sub-tasks.

Available roles:
${JSON.stringify(availableRoles, null, 2)}

Respond in JSON:
{
  "nodes": [
    {
      "roleId": "researcher",
      "description": "What this agent should do",
      "dependencies": [],
      "priority": 1,
      "expectedOutputType": "research"
    }
  ]
}

Rules:
- Use 2-5 nodes (keep it focused)
- Dependencies reference task IDs: "task-0", "task-1", etc.
- Priority: lower = runs first. Tasks with same priority and no deps run in parallel.
- expectedOutputType: "research" | "analysis" | "synthesis" | "validation"
- Always end with a writer or analyst for final synthesis
- Use "task-N" for IDs (0-indexed)`,
      },
      { role: "user", content: task },
    ],
    temperature: 0.3,
    maxTokens: 1500,
  });

  const content = response.content ?? "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);

  let nodes: PlanNode[];

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { nodes: PlanNode[] };
      nodes = (parsed.nodes ?? []).map((n, i) => ({
        id: `task-${i}`,
        roleId: n.roleId || "researcher",
        description: n.description || task,
        dependencies: n.dependencies || [],
        priority: n.priority || i + 1,
        expectedOutputType: n.expectedOutputType || "research",
      }));
    } catch {
      nodes = [{ id: "task-0", roleId: "researcher", description: task, dependencies: [], priority: 1, expectedOutputType: "research" }];
    }
  } else {
    nodes = [{ id: "task-0", roleId: "researcher", description: task, dependencies: [], priority: 1, expectedOutputType: "research" }];
  }

  const roleCards = nodes.map((n) => getRoleCard(n.roleId)).filter(Boolean) as RoleCard[];
  const estimatedTokens = roleCards.reduce((sum, r) => sum + r.maxTokens * 2, 0);

  return {
    planId,
    strategy: "llm",
    nodes,
    estimatedTokens,
    estimatedCostCents: Math.ceil(estimatedTokens / 1000 * 0.3),
    estimatedDurationMs: roleCards.reduce((sum, r) => sum + r.timeout, 0),
    parallelismFactor: nodes.filter((n) => n.dependencies.length === 0).length,
  };
}

// ── Refine Template with LLM ────────────────────────────────────────

async function refinePlanWithLLM(
  plan: SwarmPlan,
  task: string,
  inferenceClient: InferenceClient,
  _baseConfig: AgentConfig,
): Promise<SwarmPlan> {
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are reviewing a swarm execution plan. The plan was generated from a template.
Suggest improvements: better task descriptions, missing steps, or unnecessary steps.
Respond in JSON: { "refinedDescriptions": ["desc1", "desc2", ...], "addNodes": [], "removeNodeIds": [] }
Only suggest changes if truly needed. The current plan may be sufficient.`,
      },
      {
        role: "user",
        content: `Task: ${task}\n\nCurrent plan:\n${JSON.stringify(plan.nodes, null, 2)}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 1000,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ...plan, strategy: "adaptive" };

    const refinements = JSON.parse(jsonMatch[0]) as {
      refinedDescriptions?: string[];
      removeNodeIds?: string[];
    };

    // Apply refined descriptions
    if (refinements.refinedDescriptions) {
      for (let i = 0; i < Math.min(refinements.refinedDescriptions.length, plan.nodes.length); i++) {
        const desc = refinements.refinedDescriptions[i];
        if (desc && plan.nodes[i]) {
          plan.nodes[i]!.description = desc;
        }
      }
    }

    // Remove nodes
    if (refinements.removeNodeIds?.length) {
      const removeSet = new Set(refinements.removeNodeIds);
      plan.nodes = plan.nodes.filter((n) => !removeSet.has(n.id));
    }

    return { ...plan, strategy: "adaptive" };
  } catch {
    return { ...plan, strategy: "adaptive" };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatPlanAsTask(plan: SwarmPlan): string {
  const lines = plan.nodes.map((n) => `- [${n.roleId}] ${n.description}`);
  return `Execute this plan:\n${lines.join("\n")}`;
}

async function persistPlan(uid: string, plan: SwarmPlan): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO swarm_plans (id, user_id, strategy, plan, status, created_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', NOW())
     ON CONFLICT (id) DO UPDATE SET plan = $4::jsonb, status = 'pending'`,
    [plan.planId, uid, plan.strategy, JSON.stringify(plan)],
  );
}

export async function getPlan(planId: string): Promise<SwarmPlan | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ plan: SwarmPlan }>(
    "SELECT plan FROM swarm_plans WHERE id = $1",
    [planId],
  );
  return rows[0]?.plan ?? null;
}

// ── Multi-Turn Planning Mode ──────────────────────────────────────────
// Lightweight sequential planner: decompose → execute steps → synthesize.
// This is separate from the swarm planner above; it uses a single agent
// to work through a goal step-by-step in a conversational loop.

export interface PlannerStepResult {
  step: string;
  index: number;
  response: string;
  durationMs: number;
  error?: string;
}

export interface PlannerResult {
  goal: string;
  plan: string[];
  steps: PlannerStepResult[];
  synthesis: string;
}

export interface PlannerSessionContext {
  uid: string;
  sessionId: string;
  workspaceId?: string;
}

const _DECOMPOSE_SYSTEM = `You are a planning assistant. When given a goal, respond ONLY with a
JSON array of step strings — no prose, no explanation. Each step must be a clear, actionable task.
Example: ["Research X", "Draft outline", "Write section 1", "Review and finalize"]`;

const _SYNTHESIZE_SYSTEM = `You are a synthesis assistant. Given the original goal and the results
of each completed step, write a coherent, consolidated final answer.`;

/**
 * Runs a structured multi-turn planner:
 * 1. Calls inference to decompose goal into steps
 * 2. Executes each step sequentially with the agent
 * 3. Synthesizes all step results into a final answer
 */
export async function runPlannerMode(
  goal: string,
  agentConfig: AgentConfig,
  client: InferenceClient,
  ctx: PlannerSessionContext,
): Promise<PlannerResult> {
  // Step 1: Decompose goal into plan
  const decomposeResp = await client.chat({
    messages: [
      { role: "system", content: _DECOMPOSE_SYSTEM },
      { role: "user", content: `Goal: ${goal}` },
    ],
    temperature: 0.3,
    maxTokens: 512,
    sessionId: ctx.sessionId,
  });

  let plan: string[] = [];
  try {
    const raw = (decomposeResp.content ?? "").trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        plan = parsed.filter((s): s is string => typeof s === "string");
      }
    }
  } catch {
    plan = [decomposeResp.content ?? goal];
  }
  if (plan.length === 0) plan = [goal];

  // Step 2: Execute each step sequentially
  const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  const stepResults: PlannerStepResult[] = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i]!;
    const stepStart = Date.now();
    conversationHistory.push({ role: "user", content: `Step ${i + 1}: ${step}` });

    try {
      const stepResp = await client.chat({
        messages: [
          { role: "system", content: agentConfig.systemPromptTemplate },
          ...conversationHistory,
        ],
        temperature: agentConfig.model.temperature,
        maxTokens: agentConfig.model.maxOutputTokens,
        sessionId: ctx.sessionId,
      });
      const responseContent = stepResp.content ?? "";
      conversationHistory.push({ role: "assistant", content: responseContent });
      stepResults.push({ step, index: i, response: responseContent, durationMs: Date.now() - stepStart });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      conversationHistory.push({ role: "assistant", content: `Error: ${errorMsg}` });
      stepResults.push({ step, index: i, response: "", durationMs: Date.now() - stepStart, error: errorMsg });
    }
  }

  // Step 3: Synthesize
  const stepSummaries = stepResults
    .map((s, i) => `Step ${i + 1} (${s.step}):\n${s.response || s.error || "(no output)"}`)
    .join("\n\n");

  const synthesisResp = await client.chat({
    messages: [
      { role: "system", content: _SYNTHESIZE_SYSTEM },
      {
        role: "user",
        content: `Original goal: ${goal}\n\nStep results:\n${stepSummaries}\n\nPlease provide a final consolidated answer.`,
      },
    ],
    temperature: 0.5,
    maxTokens: agentConfig.model.maxOutputTokens,
    sessionId: ctx.sessionId,
  }).catch(() => ({ content: stepResults.map((s) => s.response).join("\n\n") }));

  return {
    goal,
    plan,
    steps: stepResults,
    synthesis: synthesisResp.content ?? "",
  };
}
