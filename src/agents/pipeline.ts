import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import type { InferenceClient } from "../inference/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-pipeline");

// ── Types ────────────────────────────────────────────────────────────

export type ResolveClientFn = (config: AgentConfig) => InferenceClient;

export interface PipelineStage {
  agentId: string;
  systemPromptSuffix?: string;
}

export interface BaseCtx {
  uid: string;
  workspaceId?: string;
}

export interface StageOutput {
  agentId: string;
  input: string;
  output: string;
  durationMs: number;
}

export interface PipelineResult {
  pipelineId: string;
  stages: StageOutput[];
  finalOutput: string;
  totalDurationMs: number;
}

// ── Pipeline Execution ───────────────────────────────────────────────

/**
 * Chains multiple agents sequentially.
 * The output of each stage becomes the input to the next stage.
 */
export async function runPipeline(
  input: string,
  stages: PipelineStage[],
  resolveClient: ResolveClientFn,
  _ctx: BaseCtx,
): Promise<PipelineResult> {
  const pipelineId = randomUUID();
  const pipelineStart = Date.now();
  const stageOutputs: StageOutput[] = [];

  if (stages.length === 0) {
    throw new Error("Pipeline must have at least one stage");
  }

  let currentInput = input;

  for (const stage of stages) {
    const stageStart = Date.now();
    const { getAgentConfig } = await import("../config/agents.js");
    const agentConfig = getAgentConfig(stage.agentId);
    const client = resolveClient(agentConfig);

    // Build system prompt with optional suffix
    const systemPrompt = stage.systemPromptSuffix
      ? `${agentConfig.systemPromptTemplate}\n\n${stage.systemPromptSuffix}`
      : agentConfig.systemPromptTemplate;

    logger.info(`[pipeline:${pipelineId.slice(0, 8)}] stage ${stage.agentId} starting`);

    const response = await client.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: currentInput },
      ],
      temperature: agentConfig.model.temperature,
      maxTokens: agentConfig.model.maxOutputTokens,
      sessionId: randomUUID(),
    });

    const output = response.content ?? "";
    const durationMs = Date.now() - stageStart;

    stageOutputs.push({
      agentId: stage.agentId,
      input: currentInput,
      output,
      durationMs,
    });

    logger.info(`[pipeline:${pipelineId.slice(0, 8)}] stage ${stage.agentId} done in ${durationMs}ms`);

    // Output of this stage becomes input to the next stage
    currentInput = output;
  }

  const finalOutput = stageOutputs[stageOutputs.length - 1]?.output ?? "";

  return {
    pipelineId,
    stages: stageOutputs,
    finalOutput,
    totalDurationMs: Date.now() - pipelineStart,
  };
}
