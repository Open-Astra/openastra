import { readFileSync } from "node:fs";
import type { InferenceClient, ChatMessage } from "../inference/types.js";
import { getAgentConfig } from "../config/agents.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pipeline-templates");

// ── Pipeline Templates (YAML-defined) ────────────────────────────────
// Multi-agent pipelines defined in YAML with dependency-based execution.
// Steps with no dependencies run in parallel; dependent steps wait for
// their prerequisites.

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
}

export interface PipelineStep {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  condition?: string;
}

/**
 * Parse a pipeline template file. Supports JSON natively.
 * For YAML, dynamically imports the `yaml` package if available.
 */
async function parsePipelineFile(content: string): Promise<unknown> {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // Attempt dynamic import of yaml package
  try {
    // @ts-expect-error — yaml package is optional; falls back to JSON if not installed
    const yamlMod = (await import("yaml")) as { parse: (s: string) => unknown };
    return yamlMod.parse(content);
  } catch {
    // If yaml package not available, try treating as JSON
    return JSON.parse(content);
  }
}

/**
 * Load pipeline templates from a YAML or JSON file.
 */
export async function loadPipelineTemplates(yamlPath: string): Promise<PipelineTemplate[]> {
  const content = readFileSync(yamlPath, "utf-8");
  const parsed = await parsePipelineFile(content) as { pipelines?: RawPipelineTemplate[] };

  if (!parsed.pipelines || !Array.isArray(parsed.pipelines)) {
    return [];
  }

  return parsed.pipelines.map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    description: String(p.description ?? ""),
    steps: (p.steps ?? []).map((s: RawPipelineStep) => ({
      id: String(s.id ?? ""),
      agentId: String(s.agentId ?? s.agent_id ?? ""),
      prompt: String(s.prompt ?? ""),
      dependsOn: s.dependsOn ?? s.depends_on,
      condition: s.condition,
    })),
  }));
}

interface RawPipelineTemplate {
  id?: string;
  name?: string;
  description?: string;
  steps?: RawPipelineStep[];
}

interface RawPipelineStep {
  id?: string;
  agentId?: string;
  agent_id?: string;
  prompt?: string;
  dependsOn?: string[];
  depends_on?: string[];
  condition?: string;
}

/**
 * Topologically sort steps by dependencies.
 * Returns steps in layers — each layer can run in parallel.
 */
function topologicalLayers(steps: PipelineStep[]): PipelineStep[][] {
  const stepMap = new Map<string, PipelineStep>();
  for (const s of steps) {
    stepMap.set(s.id, s);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const s of steps) {
    inDegree.set(s.id, (s.dependsOn ?? []).length);
    for (const dep of s.dependsOn ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(s.id);
      dependents.set(dep, existing);
    }
  }

  const layers: PipelineStep[][] = [];
  const resolved = new Set<string>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const layer: PipelineStep[] = [];
    for (const s of steps) {
      if (resolved.has(s.id)) continue;
      if ((inDegree.get(s.id) ?? 0) === 0) {
        layer.push(s);
      }
    }

    if (layer.length === 0) break;

    layers.push(layer);

    for (const s of layer) {
      resolved.add(s.id);
      for (const depId of dependents.get(s.id) ?? []) {
        inDegree.set(depId, (inDegree.get(depId) ?? 1) - 1);
      }
    }
  }

  // Check for unresolved (cycle detection)
  if (resolved.size < steps.length) {
    const unresolved = steps.filter((s) => !resolved.has(s.id)).map((s) => s.id);
    log.warn(`Circular dependency detected in steps: ${unresolved.join(", ")}`);
  }

  return layers;
}

/**
 * Evaluate a simple condition expression.
 * Supports: "previousResult.confidence > 0.8", truthy checks, etc.
 */
function evaluateCondition(condition: string, context: Record<string, string>): boolean {
  try {
    // Simple expression evaluator for safe patterns
    const previousResult = context._lastResult ?? "";

    // Check for comparison patterns
    const compMatch = condition.match(/^previousResult\s*(>|<|>=|<=|===|!==|==|!=)\s*(.+)$/);
    if (compMatch) {
      const op = compMatch[1];
      const rhs = compMatch[2].trim().replace(/^["']|["']$/g, "");
      const lhs = previousResult;

      const numLhs = Number(lhs);
      const numRhs = Number(rhs);

      if (!isNaN(numLhs) && !isNaN(numRhs)) {
        switch (op) {
          case ">": return numLhs > numRhs;
          case "<": return numLhs < numRhs;
          case ">=": return numLhs >= numRhs;
          case "<=": return numLhs <= numRhs;
          case "==": case "===": return numLhs === numRhs;
          case "!=": case "!==": return numLhs !== numRhs;
          default: return true;
        }
      }
      // String comparison
      switch (op) {
        case "==": case "===": return lhs === rhs;
        case "!=": case "!==": return lhs !== rhs;
        default: return true;
      }
    }

    // Truthy check on previousResult
    if (condition === "previousResult") {
      return !!previousResult && previousResult !== "false" && previousResult !== "0";
    }

    return true;
  } catch {
    return true; // Default to running the step
  }
}

/**
 * Substitute template variables in a prompt string.
 * Supports {{previousResult}}, {{input}}, and {{stepId.result}} patterns.
 */
function substitutePrompt(
  prompt: string,
  input: string,
  stepResults: Map<string, string>,
  lastResult: string,
): string {
  let result = prompt.replace(/\{\{input\}\}/g, input);
  result = result.replace(/\{\{previousResult\}\}/g, lastResult);

  // Replace {{stepId}} references
  result = result.replace(/\{\{(\w+)\}\}/g, (match, stepId: string) => {
    return stepResults.get(stepId) ?? match;
  });

  return result;
}

/**
 * Execute a pipeline template.
 *
 * 1. Topologically sorts steps by dependencies
 * 2. Runs independent steps in parallel
 * 3. Substitutes {{previousResult}} with the last step's output
 * 4. Returns all step results as a map of stepId -> result
 */
export async function executePipeline(
  template: PipelineTemplate,
  input: string,
  _uid: string,
  inferenceClients: Map<string, InferenceClient>,
): Promise<Map<string, string>> {
  const stepResults = new Map<string, string>();
  let lastResult = "";

  const layers = topologicalLayers(template.steps);

  for (const layer of layers) {
    const layerPromises = layer.map(async (step) => {
      // Check condition
      if (step.condition) {
        const context: Record<string, string> = { _lastResult: lastResult };
        for (const [k, v] of stepResults) {
          context[k] = v;
        }
        if (!evaluateCondition(step.condition, context)) {
          log.info(`Skipping step ${step.id}: condition not met`);
          stepResults.set(step.id, "");
          return;
        }
      }

      // Get agent config and client
      let client = inferenceClients.get(step.agentId);
      let agentConfig;
      try {
        agentConfig = getAgentConfig(step.agentId);
      } catch {
        log.warn(`Agent ${step.agentId} not found, skipping step ${step.id}`);
        stepResults.set(step.id, `Error: agent ${step.agentId} not found`);
        return;
      }

      if (!client) {
        // Try to get from the map using agent ID
        log.warn(`No inference client for agent ${step.agentId} in step ${step.id}`);
        stepResults.set(step.id, `Error: no client for agent ${step.agentId}`);
        return;
      }

      // Build prompt with substitutions
      const prompt = substitutePrompt(step.prompt, input, stepResults, lastResult);

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: agentConfig.systemPromptTemplate,
        },
        {
          role: "user",
          content: prompt,
        },
      ];

      try {
        const response = await client.chat({
          messages,
          temperature: agentConfig.model.temperature,
          maxTokens: agentConfig.model.maxOutputTokens,
        });

        const content = response.content ?? "";
        stepResults.set(step.id, content);
      } catch (err) {
        log.warn(`Step ${step.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        stepResults.set(step.id, `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    await Promise.all(layerPromises);

    // Update lastResult to be the result of the last step in this layer
    const lastStep = layer[layer.length - 1];
    lastResult = stepResults.get(lastStep.id) ?? lastResult;
  }

  return stepResults;
}
