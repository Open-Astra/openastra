import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { executeTool } from "../../../tools/index.js";

// ── Workflow / Automation Engine Skill ─────────────────────────────
// Runtime tool orchestration — chain multiple tools together with
// conditionals, variable passing between steps, and error handling.
//
// Unlike the procedure executor (which runs stored procedures from
// memory), this skill executes ad-hoc workflows defined inline.

const StepSchema = z.object({
  id: z.string().describe("Unique step identifier"),
  tool: z.string().describe("Tool name to call"),
  params: z.record(z.string(), z.unknown()).describe("Tool parameters (use {{stepId.field}} for references to prior step results)"),
  condition: z.string().optional().describe("Condition to evaluate: 'always' | 'stepId.success' | 'stepId.field == value'"),
  onError: z.enum(["stop", "skip", "continue"]).optional().describe("Error handling: stop workflow, skip step, or continue (default: stop)"),
});

const RunWorkflowParams = z.object({
  name: z.string().optional().describe("Optional workflow name for logging"),
  steps: z.array(StepSchema).min(1).max(10).describe("Ordered steps to execute (max 10)"),
  variables: z.record(z.string(), z.unknown()).optional().describe("Initial variables available to all steps via {{var.name}}"),
  dryRun: z.boolean().optional().describe("Preview the workflow without executing tools"),
});

const ParallelStepsParams = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      params: z.record(z.string(), z.unknown()),
    }),
  ).min(2).max(5).describe("Steps to execute in parallel (2-5)"),
});

type StepResult = {
  id: string;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
  skipped?: boolean;
  durationMs: number;
};

function resolveReferences(
  value: unknown,
  stepResults: Map<string, { success: boolean; parsed: Record<string, unknown> }>,
  variables: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    // Replace {{stepId.field}} and {{var.name}} references
    return value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_, source, field) => {
      if (source === "var") {
        return String(variables[field] ?? "");
      }
      const stepData = stepResults.get(source);
      if (stepData?.parsed) {
        return String(stepData.parsed[field] ?? "");
      }
      return "";
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveReferences(v, stepResults, variables));
  }
  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveReferences(v, stepResults, variables);
    }
    return resolved;
  }
  return value;
}

function evaluateCondition(
  condition: string,
  stepResults: Map<string, { success: boolean; parsed: Record<string, unknown> }>,
): boolean {
  const trimmed = condition.trim().toLowerCase();
  if (trimmed === "always" || trimmed === "true") return true;
  if (trimmed === "never" || trimmed === "false") return false;

  // "stepId.success" — check if step succeeded
  const successMatch = condition.match(/^(\w+)\.success$/);
  if (successMatch) {
    return stepResults.get(successMatch[1]!)?.success ?? false;
  }

  // "stepId.field == value"
  const eqMatch = condition.match(/^(\w+)\.(\w+)\s*==\s*(.+)$/);
  if (eqMatch) {
    const stepData = stepResults.get(eqMatch[1]!);
    const fieldValue = String(stepData?.parsed?.[eqMatch[2]!] ?? "");
    return fieldValue === eqMatch[3]!.trim();
  }

  // "stepId.field != value"
  const neqMatch = condition.match(/^(\w+)\.(\w+)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const stepData = stepResults.get(neqMatch[1]!);
    const fieldValue = String(stepData?.parsed?.[neqMatch[2]!] ?? "");
    return fieldValue !== neqMatch[3]!.trim();
  }

  return true; // unknown condition format — execute by default
}

const workflowEngineSkill: SkillDefinition = {
  name: "workflow_engine",
  version: "1.0.0",

  manifest: {
    id: "workflow_engine",
    name: "Workflow Engine",
    description: "Chain multiple tools together in a defined sequence with conditionals, variable passing, error handling, and parallel execution.",
    category: "execute",
    tools: ["run_workflow", "run_parallel_steps"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "run_workflow",
      description: "Execute a multi-step workflow that chains tools together. Steps run in order with variable passing ({{stepId.field}}), conditional execution, and configurable error handling.",
      parameters: RunWorkflowParams,

      async execute(params, toolCtx) {
        const variables = params.variables ?? {};
        const dryRun = params.dryRun ?? false;
        const stepResults = new Map<string, { success: boolean; parsed: Record<string, unknown> }>();
        const results: StepResult[] = [];
        const startTime = Date.now();

        for (const step of params.steps) {
          // Check condition
          if (step.condition && !evaluateCondition(step.condition, stepResults)) {
            results.push({
              id: step.id,
              tool: step.tool,
              success: true,
              skipped: true,
              durationMs: 0,
            });
            stepResults.set(step.id, { success: true, parsed: {} });
            continue;
          }

          // Resolve parameter references
          const resolvedParams = resolveReferences(step.params, stepResults, variables) as Record<string, unknown>;

          if (dryRun) {
            results.push({
              id: step.id,
              tool: step.tool,
              success: true,
              result: `[DRY RUN] Would call ${step.tool} with params: ${JSON.stringify(resolvedParams)}`,
              durationMs: 0,
            });
            stepResults.set(step.id, { success: true, parsed: resolvedParams });
            continue;
          }

          const stepStart = Date.now();
          try {
            const toolResult = await executeTool(
              {
                id: `wf-${step.id}`,
                name: step.tool,
                arguments: JSON.stringify(resolvedParams),
              },
              toolCtx,
              new Set([step.tool]),
            );

            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(toolResult.content);
            } catch {
              parsed = { raw: toolResult.content };
            }

            const success = !toolResult.error;
            stepResults.set(step.id, { success, parsed });
            results.push({
              id: step.id,
              tool: step.tool,
              success,
              result: toolResult.content.slice(0, 500),
              error: toolResult.error,
              durationMs: Date.now() - stepStart,
            });

            if (!success) {
              const onError = step.onError ?? "stop";
              if (onError === "stop") break;
              // "skip" and "continue" both continue — the difference is
              // in how downstream conditions can react
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            stepResults.set(step.id, { success: false, parsed: { error: errorMsg } });
            results.push({
              id: step.id,
              tool: step.tool,
              success: false,
              error: errorMsg,
              durationMs: Date.now() - stepStart,
            });

            if ((step.onError ?? "stop") === "stop") break;
          }
        }

        return {
          workflowName: params.name ?? "unnamed",
          dryRun,
          totalSteps: params.steps.length,
          executedSteps: results.filter((r) => !r.skipped).length,
          skippedSteps: results.filter((r) => r.skipped).length,
          successfulSteps: results.filter((r) => r.success && !r.skipped).length,
          totalDurationMs: Date.now() - startTime,
          steps: results,
        };
      },
    });

    ctx.registerTool({
      name: "run_parallel_steps",
      description: "Execute multiple independent tool calls in parallel. All steps run concurrently and results are returned together.",
      parameters: ParallelStepsParams,

      async execute(params, toolCtx) {
        const startTime = Date.now();

        const promises = params.steps.map(async (step) => {
          const stepStart = Date.now();
          try {
            const toolResult = await executeTool(
              {
                id: `par-${step.id}`,
                name: step.tool,
                arguments: JSON.stringify(step.params),
              },
              toolCtx,
              new Set([step.tool]),
            );

            return {
              id: step.id,
              tool: step.tool,
              success: !toolResult.error,
              result: toolResult.content.slice(0, 500),
              error: toolResult.error,
              durationMs: Date.now() - stepStart,
            };
          } catch (err) {
            return {
              id: step.id,
              tool: step.tool,
              success: false,
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - stepStart,
            };
          }
        });

        const results = await Promise.all(promises);

        return {
          totalSteps: params.steps.length,
          successfulSteps: results.filter((r) => r.success).length,
          totalDurationMs: Date.now() - startTime,
          steps: results,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "workflow_engine",
      instructions:
        "You can chain tools together: `run_workflow` executes steps sequentially with variable passing ({{stepId.field}}), conditionals, and error handling (stop/skip/continue). `run_parallel_steps` runs independent tool calls concurrently. Use workflows to automate multi-step operations.",
    };
  },
};

export default workflowEngineSkill;
