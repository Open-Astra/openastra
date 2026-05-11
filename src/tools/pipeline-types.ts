// ── Tool Composition DSL Types (Feature 36) ─────────────────────────
// Type definitions for composing tools into pipelines.

import type { RetryPolicy } from "./types.js";

export interface PipelineStep {
  toolName: string;
  /** Parameter template with $prev/$input/$prev.field references */
  paramsTemplate?: Record<string, unknown>;
  retryPolicy?: Pick<RetryPolicy, "maxAttempts" | "backoffMs">;
  onError: "skip" | "abort" | "fallback";
  fallbackToolName?: string;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  description?: string;
  steps: PipelineStep[];
}

export interface StepResult {
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

export interface PipelineResult {
  pipelineId: string;
  steps: StepResult[];
  finalOutput: unknown;
  totalDurationMs: number;
  errors: string[];
}
