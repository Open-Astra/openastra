// ── Tool Composition DSL (Feature 36) ────────────────────────────────
// Parse and execute tool pipelines: "web-search | summarize | memory-write"
// Supports $prev/$input variable substitution, per-step retry, and
// configurable error propagation (skip/abort/fallback).

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./types.js";
import type { PipelineDefinition, PipelineStep, PipelineResult, StepResult } from "./pipeline-types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-pipeline");

// ── Pipeline Registry ────────────────────────────────────────────────

const pipelines = new Map<string, PipelineDefinition>();

export function registerPipeline(def: PipelineDefinition): void {
  pipelines.set(def.id, def);
  logger.dim(`Registered pipeline: ${def.id} (${def.steps.length} steps)`);
}

export function getPipeline(id: string): PipelineDefinition | undefined {
  return pipelines.get(id);
}

export function getAllPipelines(): Map<string, PipelineDefinition> {
  return pipelines;
}

export function unregisterPipeline(id: string): boolean {
  return pipelines.delete(id);
}

// ── DSL Parser ───────────────────────────────────────────────────────
// Parses: "web-search | summarize | memory-write"
// Also supports params: 'web-search({"query":"$input"}) | summarize'

export function parsePipelineDSL(dsl: string): PipelineDefinition {
  const raw = dsl.trim();
  const segments = raw.split("|").map((s) => s.trim()).filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Pipeline DSL is empty — expected at least one tool name");
  }

  const steps: PipelineStep[] = segments.map((segment) => {
    // Match: tool_name or tool_name({"key":"val"})
    const match = segment.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(?:\((.+)\))?$/);

    if (!match) {
      throw new Error(`Invalid pipeline segment: "${segment}". Expected: tool_name or tool_name({"params":...})`);
    }

    const toolName = match[1]!;
    let paramsTemplate: Record<string, unknown> | undefined;

    if (match[2]) {
      try {
        paramsTemplate = JSON.parse(match[2]);
      } catch {
        throw new Error(`Invalid JSON params in pipeline segment "${segment}": ${match[2]}`);
      }
    }

    return {
      toolName,
      paramsTemplate,
      onError: "abort" as const,
    };
  });

  return {
    id: `dsl-${randomUUID().slice(0, 8)}`,
    name: raw,
    steps,
  };
}

// ── Pipeline Executor ────────────────────────────────────────────────

export async function executePipeline(
  pipeline: PipelineDefinition,
  input: unknown,
  ctx: ToolContext,
): Promise<PipelineResult> {
  const start = Date.now();
  const stepResults: StepResult[] = [];
  const errors: string[] = [];
  let prevOutput: unknown = input;

  // Lazy import to avoid circular dependency
  const { executeTool } = await import("./registry.js");

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i]!;
    const stepStart = Date.now();

    // Resolve parameters with variable substitution
    const resolvedParams = step.paramsTemplate
      ? resolveTemplate(step.paramsTemplate, prevOutput, input)
      : (i === 0 ? input : prevOutput);

    const toolCall = {
      id: randomUUID(),
      name: step.toolName,
      arguments: JSON.stringify(resolvedParams),
    };

    // All tools are allowed within a pipeline execution
    const allowAll = new Set([step.toolName]);
    if (step.fallbackToolName) allowAll.add(step.fallbackToolName);

    const maxAttempts = step.retryPolicy?.maxAttempts ?? 1;
    const backoffMs = step.retryPolicy?.backoffMs ?? 200;
    let lastError: string | undefined;
    let result: unknown;
    let succeeded = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const toolResult = await executeTool(toolCall, ctx, allowAll);

      if (!toolResult.error) {
        try {
          result = JSON.parse(toolResult.content);
        } catch {
          result = toolResult.content;
        }
        succeeded = true;
        break;
      }

      lastError = toolResult.error;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
      }
    }

    if (!succeeded) {
      // Try fallback tool if configured
      if (step.fallbackToolName) {
        const fallbackCall = { ...toolCall, name: step.fallbackToolName };
        const fallbackResult = await executeTool(fallbackCall, ctx, allowAll);

        if (!fallbackResult.error) {
          try {
            result = JSON.parse(fallbackResult.content);
          } catch {
            result = fallbackResult.content;
          }
          succeeded = true;
          lastError = undefined;
        }
      }
    }

    if (!succeeded) {
      const errorMsg = `Step ${i + 1} (${step.toolName}) failed: ${lastError}`;
      errors.push(errorMsg);

      if (step.onError === "abort") {
        stepResults.push({
          toolName: step.toolName,
          input: resolvedParams,
          output: null,
          durationMs: Date.now() - stepStart,
          error: lastError,
        });
        break;
      }

      if (step.onError === "skip") {
        stepResults.push({
          toolName: step.toolName,
          input: resolvedParams,
          output: null,
          durationMs: Date.now() - stepStart,
          error: lastError,
          skipped: true,
        });
        // prevOutput stays the same — skip this step's output
        continue;
      }
    }

    stepResults.push({
      toolName: step.toolName,
      input: resolvedParams,
      output: result ?? null,
      durationMs: Date.now() - stepStart,
      error: lastError,
    });

    if (succeeded) {
      prevOutput = result;
    }
  }

  return {
    pipelineId: pipeline.id,
    steps: stepResults,
    finalOutput: prevOutput,
    totalDurationMs: Date.now() - start,
    errors,
  };
}

// ── Template Resolution ──────────────────────────────────────────────
// Recursively walks a template object and replaces $prev/$input refs.

function resolveTemplate(
  template: Record<string, unknown>,
  prev: unknown,
  input: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(template)) {
    result[key] = resolveValue(value, prev, input);
  }

  return result;
}

function resolveValue(value: unknown, prev: unknown, input: unknown): unknown {
  if (typeof value === "string") {
    // Exact match replacements
    if (value === "$prev") return prev;
    if (value === "$input") return input;

    // Nested access: $prev.field.subfield
    if (value.startsWith("$prev.")) {
      return accessPath(prev, value.slice(6));
    }
    if (value.startsWith("$input.")) {
      return accessPath(input, value.slice(7));
    }

    // String interpolation: "Search for $input"
    let resolved = value;
    resolved = resolved.replace(/\$prev/g, stringify(prev));
    resolved = resolved.replace(/\$input/g, stringify(input));
    return resolved === value ? value : resolved;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, prev, input));
  }

  if (value !== null && typeof value === "object") {
    return resolveTemplate(value as Record<string, unknown>, prev, input);
  }

  return value;
}

function accessPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function stringify(val: unknown): string {
  if (typeof val === "string") return val;
  if (val == null) return "";
  return JSON.stringify(val);
}
