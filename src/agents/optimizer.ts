import { randomUUID } from "node:crypto";
import type { InferenceClient, InferenceResponse } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { getPool } from "../config/postgres.js";
import { reflectOnResponse } from "./reflection.js";
import { createLogger } from "../utils/logger.js";

// ── Meta-Agent Optimizer ────────────────────────────────────────────
// A/B tests temperature, models, and prompt variants to find the
// optimal configuration for each agent. Runs experiments in the
// background, tracks quality metrics, and suggests (or auto-applies)
// improvements.
//
// Experiment types:
//   - Temperature sweep: test [0.1, 0.3, 0.5, 0.7, 0.9]
//   - Model comparison: same prompt across different models
//   - Prompt variant: test alternative system prompt wordings
//
// Scoring: reflection confidence + user feedback + latency + cost

const log = createLogger("optimizer");

// ── Types ───────────────────────────────────────────────────────────

export type ExperimentType = "temperature" | "model" | "prompt";

export interface Experiment {
  id: string;
  agentId: string;
  type: ExperimentType;
  status: "running" | "completed" | "failed";
  variants: ExperimentVariant[];
  winner?: string;                // variant ID of the winner
  createdAt: number;
  completedAt?: number;
}

export interface ExperimentVariant {
  id: string;
  label: string;
  config: Partial<AgentConfig["model"]> & { systemPromptOverride?: string };
  scores: VariantScore[];
  avgScore: number;
  sampleCount: number;
}

export interface VariantScore {
  trialId: string;
  reflectionConfidence: number;   // 0-1 from reflection
  latencyMs: number;
  tokenCost: number;              // estimated cost in cents
  userFeedback?: number;          // -1 (downvote) to +1 (upvote)
  compositeScore: number;         // weighted combination
  timestamp: number;
}

export interface OptimizerConfig {
  samplesPerVariant: number;      // how many trials per variant (default: 5)
  autoApply: boolean;             // automatically apply winner (default: false)
  qualityWeight: number;          // weight for reflection confidence (default: 0.5)
  latencyWeight: number;          // weight for latency (default: 0.2)
  costWeight: number;             // weight for cost efficiency (default: 0.3)
}

const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  samplesPerVariant: 5,
  autoApply: false,
  qualityWeight: 0.5,
  latencyWeight: 0.2,
  costWeight: 0.3,
};

// ── Temperature Experiment ──────────────────────────────────────────

export async function runTemperatureExperiment(
  agentId: string,
  baseConfig: AgentConfig,
  testPrompt: string,
  inferenceClient: InferenceClient,
  config: Partial<OptimizerConfig> = {},
): Promise<Experiment> {
  const opts = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
  const temperatures = [0.1, 0.3, 0.5, 0.7, 0.9];

  const experiment: Experiment = {
    id: randomUUID(),
    agentId,
    type: "temperature",
    status: "running",
    variants: temperatures.map((t) => ({
      id: `temp-${t}`,
      label: `temperature=${t}`,
      config: { temperature: t },
      scores: [],
      avgScore: 0,
      sampleCount: 0,
    })),
    createdAt: Date.now(),
  };

  log.info(`Starting temperature experiment for ${agentId} (${experiment.id.slice(0, 8)})`);

  for (const variant of experiment.variants) {
    for (let trial = 0; trial < opts.samplesPerVariant; trial++) {
      const score = await runTrial(
        testPrompt,
        baseConfig,
        variant.config,
        inferenceClient,
        opts,
      );
      variant.scores.push(score);
      variant.sampleCount++;
    }
    variant.avgScore = variant.scores.reduce((s, v) => s + v.compositeScore, 0) / variant.scores.length;
  }

  // Determine winner
  experiment.variants.sort((a, b) => b.avgScore - a.avgScore);
  experiment.winner = experiment.variants[0]?.id;
  experiment.status = "completed";
  experiment.completedAt = Date.now();

  await persistExperiment(experiment);

  log.info(`Temperature experiment complete: winner=${experiment.winner} (score=${experiment.variants[0]?.avgScore.toFixed(3)})`);

  return experiment;
}

// ── Model Comparison Experiment ─────────────────────────────────────

export async function runModelExperiment(
  agentId: string,
  baseConfig: AgentConfig,
  testPrompt: string,
  modelVariants: Array<{ label: string; provider: string; modelId: string }>,
  inferenceClients: Map<string, InferenceClient>,
  config: Partial<OptimizerConfig> = {},
): Promise<Experiment> {
  const opts = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };

  const experiment: Experiment = {
    id: randomUUID(),
    agentId,
    type: "model",
    status: "running",
    variants: modelVariants.map((m) => ({
      id: `model-${m.label}`,
      label: m.label,
      config: { provider: m.provider as AgentConfig["model"]["provider"], modelId: m.modelId },
      scores: [],
      avgScore: 0,
      sampleCount: 0,
    })),
    createdAt: Date.now(),
  };

  log.info(`Starting model experiment for ${agentId} (${experiment.id.slice(0, 8)})`);

  for (const variant of experiment.variants) {
    const client = inferenceClients.get(variant.label);
    if (!client) continue;

    for (let trial = 0; trial < opts.samplesPerVariant; trial++) {
      const score = await runTrial(testPrompt, baseConfig, variant.config, client, opts);
      variant.scores.push(score);
      variant.sampleCount++;
    }
    variant.avgScore = variant.scores.reduce((s, v) => s + v.compositeScore, 0) / variant.scores.length;
  }

  experiment.variants.sort((a, b) => b.avgScore - a.avgScore);
  experiment.winner = experiment.variants[0]?.id;
  experiment.status = "completed";
  experiment.completedAt = Date.now();

  await persistExperiment(experiment);
  return experiment;
}

// ── Prompt Variant Experiment ───────────────────────────────────────

export async function runPromptExperiment(
  agentId: string,
  baseConfig: AgentConfig,
  testPrompt: string,
  promptVariants: Array<{ label: string; systemPrompt: string }>,
  inferenceClient: InferenceClient,
  config: Partial<OptimizerConfig> = {},
): Promise<Experiment> {
  const opts = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };

  const experiment: Experiment = {
    id: randomUUID(),
    agentId,
    type: "prompt",
    status: "running",
    variants: promptVariants.map((p) => ({
      id: `prompt-${p.label}`,
      label: p.label,
      config: { systemPromptOverride: p.systemPrompt },
      scores: [],
      avgScore: 0,
      sampleCount: 0,
    })),
    createdAt: Date.now(),
  };

  log.info(`Starting prompt experiment for ${agentId} (${experiment.id.slice(0, 8)})`);

  for (const variant of experiment.variants) {
    for (let trial = 0; trial < opts.samplesPerVariant; trial++) {
      const score = await runTrial(testPrompt, baseConfig, variant.config, inferenceClient, opts);
      variant.scores.push(score);
      variant.sampleCount++;
    }
    variant.avgScore = variant.scores.reduce((s, v) => s + v.compositeScore, 0) / variant.scores.length;
  }

  experiment.variants.sort((a, b) => b.avgScore - a.avgScore);
  experiment.winner = experiment.variants[0]?.id;
  experiment.status = "completed";
  experiment.completedAt = Date.now();

  await persistExperiment(experiment);
  return experiment;
}

// ── Single Trial ────────────────────────────────────────────────────

async function runTrial(
  testPrompt: string,
  baseConfig: AgentConfig,
  variantConfig: ExperimentVariant["config"],
  inferenceClient: InferenceClient,
  opts: OptimizerConfig,
): Promise<VariantScore> {
  const trialId = randomUUID();
  const start = Date.now();

  const systemPrompt = variantConfig.systemPromptOverride ?? baseConfig.systemPromptTemplate;

  let response: InferenceResponse;
  try {
    response = await inferenceClient.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: testPrompt },
      ],
      temperature: variantConfig.temperature ?? baseConfig.model.temperature,
      maxTokens: baseConfig.model.maxOutputTokens,
    });
  } catch {
    return {
      trialId,
      reflectionConfidence: 0,
      latencyMs: Date.now() - start,
      tokenCost: 0,
      compositeScore: 0,
      timestamp: Date.now(),
    };
  }

  const latencyMs = Date.now() - start;
  const tokenCost = (response.usage.totalTokens / 1000) * 0.3; // rough cost estimate

  // Run reflection to measure quality
  let reflectionConfidence = 0.5;
  try {
    const reflection = await reflectOnResponse(
      testPrompt,
      response.content ?? "",
      inferenceClient,
      trialId,
    );
    reflectionConfidence = reflection.confidence;
  } catch {
    // Reflection failure — use default confidence
  }

  // Normalize latency (lower is better, 0-1 scale)
  const latencyScore = Math.max(0, 1 - latencyMs / 30_000); // 30s = 0 score

  // Normalize cost (lower is better, 0-1 scale)
  const costScore = Math.max(0, 1 - tokenCost / 10); // $0.10 = 0 score

  const compositeScore =
    reflectionConfidence * opts.qualityWeight +
    latencyScore * opts.latencyWeight +
    costScore * opts.costWeight;

  return {
    trialId,
    reflectionConfidence,
    latencyMs,
    tokenCost,
    compositeScore,
    timestamp: Date.now(),
  };
}

// ── Record User Feedback ────────────────────────────────────────────

export async function recordOptimizationFeedback(
  experimentId: string,
  variantId: string,
  feedback: number, // -1 to +1
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE optimizer_experiments
     SET config = jsonb_set(
       config,
       '{feedback}',
       COALESCE(config->'feedback', '[]'::jsonb) || $1::jsonb
     )
     WHERE id = $2`,
    [
      JSON.stringify({ variantId, feedback, timestamp: Date.now() }),
      experimentId,
    ],
  );
}

// ── Get Best Config ─────────────────────────────────────────────────

export async function getBestConfig(agentId: string): Promise<ExperimentVariant["config"] | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: Experiment }>(
    `SELECT config FROM optimizer_experiments
     WHERE agent_id = $1 AND status = 'completed'
     ORDER BY created_at DESC LIMIT 1`,
    [agentId],
  );

  if (rows.length === 0) return null;

  const experiment = rows[0]!.config;
  const winner = experiment.variants.find((v) => v.id === experiment.winner);
  return winner?.config ?? null;
}

// ── Persistence ─────────────────────────────────────────────────────

async function persistExperiment(experiment: Experiment): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO optimizer_experiments (id, agent_id, type, status, config, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET status = $4, config = $5::jsonb`,
    [experiment.id, experiment.agentId, experiment.type, experiment.status, JSON.stringify(experiment)],
  );
}

export async function listExperiments(agentId: string): Promise<Experiment[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: Experiment }>(
    `SELECT config FROM optimizer_experiments
     WHERE agent_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [agentId],
  );
  return rows.map((r) => r.config);
}
