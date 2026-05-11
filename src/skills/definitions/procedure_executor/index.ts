import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import {
  getProcedure,
  listProcedures,
  searchProcedures,
  recordExecution,
  type ProcedureStep,
} from "../../../memory/procedural.js";
import { executeTool } from "../../../tools/index.js";

// ── Procedure Executor Skill ──────────────────────────────────────
// Bridges stored procedural memory with runtime execution. Procedures
// are stored in the procedural memory system — this skill actually
// runs them step-by-step, evaluating conditions and calling tools.

const RunProcedureParams = z.object({
  procedureId: z.string().uuid().describe("ID of the procedure to execute"),
  context: z.record(z.string(), z.unknown()).optional().describe("Key-value context variables available to step conditions and tool params"),
  dryRun: z.boolean().optional().describe("If true, show what would happen without executing tools (default false)"),
});

const FindAndRunParams = z.object({
  query: z.string().describe("Natural language description of what you want to do — finds and runs the best matching procedure"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context variables for the procedure"),
});

const ListProceduresParams = z.object({
  type: z.enum(["workflow", "decision_tree", "template", "rule", "snippet"]).optional()
    .describe("Filter by procedure type"),
});

function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  if (!condition || condition.trim() === "") return true;

  const lower = condition.toLowerCase().trim();

  // Simple variable checks: "variableName exists" or "variableName is truthy"
  for (const [key, value] of Object.entries(context)) {
    if (lower === `${key.toLowerCase()} exists`) return value != null;
    if (lower === `${key.toLowerCase()} is true`) return Boolean(value);
    if (lower === `${key.toLowerCase()} is false`) return !value;
  }

  // "always" condition
  if (lower === "always" || lower === "true") return true;
  if (lower === "never" || lower === "false") return false;

  // Default: condition not matched, execute the step
  return true;
}

function interpolateParams(
  params: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith("{{") && value.endsWith("}}")) {
      const varName = value.slice(2, -2).trim();
      result[key] = context[varName] ?? value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function executeStep(
  step: ProcedureStep,
  context: Record<string, unknown>,
  toolCtx: { uid: string; agentId: string; sessionId: string },
  dryRun: boolean,
): Promise<{ stepOrder: number; action: string; skipped: boolean; result?: unknown; error?: string }> {
  // Check condition
  if (step.condition && !evaluateCondition(step.condition, context)) {
    return { stepOrder: step.order, action: step.action, skipped: true };
  }

  if (dryRun) {
    return {
      stepOrder: step.order,
      action: step.action,
      skipped: false,
      result: `[DRY RUN] Would execute: ${step.toolCall ?? step.action}`,
    };
  }

  // Execute tool call if specified
  if (step.toolCall) {
    const params = step.toolParams
      ? interpolateParams(step.toolParams, context)
      : {};

    try {
      const toolResult = await executeTool(
        {
          id: `proc-step-${step.order}`,
          name: step.toolCall,
          arguments: JSON.stringify(params),
        },
        toolCtx,
        new Set([step.toolCall]),
      );

      return {
        stepOrder: step.order,
        action: step.action,
        skipped: false,
        result: toolResult.content,
        error: toolResult.error,
      };
    } catch (err) {
      return {
        stepOrder: step.order,
        action: step.action,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // No tool call — this step is informational
  return {
    stepOrder: step.order,
    action: step.action,
    skipped: false,
    result: "Step acknowledged (no tool call defined)",
  };
}

const procedureExecutorSkill: SkillDefinition = {
  name: "procedure_executor",
  version: "1.0.0",

  manifest: {
    id: "procedure_executor",
    name: "Procedure Executor",
    description: "Execute stored procedures from procedural memory step-by-step, evaluating conditions and calling tools. Tracks execution success rates.",
    category: "execute",
    tools: ["run_procedure", "find_and_run_procedure", "list_procedures"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "run_procedure",
      description: "Execute a specific procedure by ID. Runs each step in order, evaluating conditions and calling tools. Supports dry-run mode and context variables.",
      parameters: RunProcedureParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const procedure = await getProcedure(uid, params.procedureId);

        if (!procedure) {
          return { error: `Procedure not found: ${params.procedureId}` };
        }

        const context = params.context ?? {};
        const dryRun = params.dryRun ?? false;
        const stepResults: Awaited<ReturnType<typeof executeStep>>[] = [];
        let hasError = false;

        // Sort steps by order
        const sortedSteps = [...procedure.steps].sort((a, b) => a.order - b.order);

        for (const step of sortedSteps) {
          const result = await executeStep(step, context, toolCtx, dryRun);
          stepResults.push(result);

          if (result.error) {
            hasError = true;
            // For decision_tree type, an error stops execution
            if (procedure.type === "decision_tree") break;
          }
        }

        // Record execution result (unless dry run)
        if (!dryRun) {
          await recordExecution(uid, procedure.id, !hasError).catch(() => {});
        }

        return {
          success: !hasError,
          procedureId: procedure.id,
          procedureName: procedure.name,
          type: procedure.type,
          dryRun,
          stepsExecuted: stepResults.filter((r) => !r.skipped).length,
          stepsSkipped: stepResults.filter((r) => r.skipped).length,
          steps: stepResults,
        };
      },
    });

    ctx.registerTool({
      name: "find_and_run_procedure",
      description: "Find the best matching procedure for a natural language query and execute it. Combines search + execution in one step.",
      parameters: FindAndRunParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const results = await searchProcedures(uid, params.query, 1);

        if (results.length === 0) {
          return {
            error: "No matching procedure found for the query.",
            query: params.query,
            suggestion: "Try creating a procedure first, or rephrase your query.",
          };
        }

        const best = results[0]!;
        const procedure = best.procedure;
        const context = params.context ?? {};
        const stepResults: Awaited<ReturnType<typeof executeStep>>[] = [];
        let hasError = false;

        const sortedSteps = [...procedure.steps].sort((a, b) => a.order - b.order);

        for (const step of sortedSteps) {
          const result = await executeStep(step, context, toolCtx, false);
          stepResults.push(result);
          if (result.error && procedure.type === "decision_tree") break;
          if (result.error) hasError = true;
        }

        await recordExecution(uid, procedure.id, !hasError).catch(() => {});

        return {
          success: !hasError,
          matchScore: best.score,
          matchType: best.matchType,
          procedureId: procedure.id,
          procedureName: procedure.name,
          type: procedure.type,
          stepsExecuted: stepResults.filter((r) => !r.skipped).length,
          steps: stepResults,
        };
      },
    });

    ctx.registerTool({
      name: "list_procedures",
      description: "List available procedures from procedural memory, optionally filtered by type.",
      parameters: ListProceduresParams,

      async execute(params, toolCtx) {
        const uid = toolCtx.uid;
        const procedures = await listProcedures(uid, params.type);

        return {
          count: procedures.length,
          procedures: procedures.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            trigger: p.trigger,
            stepCount: p.steps.length,
            executionCount: p.executionCount,
            successRate:
              p.executionCount > 0
                ? Math.round((p.successCount / p.executionCount) * 100)
                : null,
            tags: p.tags,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "procedure_executor",
      instructions:
        "You can execute stored procedures: `run_procedure` runs a specific procedure by ID with optional context variables and dry-run mode, `find_and_run_procedure` searches for and runs the best matching procedure by description, and `list_procedures` shows available procedures. Procedures track their success rates.",
    };
  },
};

export default procedureExecutorSkill;
