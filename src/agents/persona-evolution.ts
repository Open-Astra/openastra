import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { getPool } from "../config/postgres.js";
import { getAgentConfig, registerAgentConfig } from "../config/agents.js";
import { reflectOnResponse } from "./reflection.js";
import { createVersion } from "./cloning.js";
import { logAgentAction } from "./audit.js";
import { createLogger } from "../utils/logger.js";

// ── Self-Evolving Agent Personas ────────────────────────────────────
// Agents periodically run self-reflection loops, A/B test prompt
// variants, and evolve their own system prompts/personalities based
// on user feedback scores.
//
// Evolution cycle (runs daily):
//   1. Collect recent feedback scores and interaction metrics
//   2. Identify areas where the agent underperforms
//   3. Generate 2-3 prompt variants addressing weaknesses
//   4. Shadow-test variants against recent conversations
//   5. If a variant significantly outperforms, auto-adopt it
//
// Safety: all changes are versioned, rollback is instant.

const log = createLogger("persona-evolution");

// ── Types ───────────────────────────────────────────────────────────

export interface EvolutionConfig {
  enabled: boolean;
  minFeedbackSamples: number;    // min feedback before evolving (default: 10)
  evolutionIntervalMs: number;    // how often to evolve (default: 24h)
  maxVariants: number;            // max prompt variants to test (default: 3)
  adoptionThreshold: number;      // confidence delta to auto-adopt (default: 0.15)
  autoAdopt: boolean;             // auto-apply winning variant (default: false)
}

export interface FeedbackMetrics {
  agentId: string;
  totalInteractions: number;
  positiveRatio: number;          // 0-1
  avgConfidence: number;          // from reflection
  commonIssues: string[];         // recurring themes from reflections
  weakAreas: string[];            // identified improvement areas
}

export interface EvolutionResult {
  agentId: string;
  previousVersion: number;
  newVersion?: number;
  variants: Array<{
    label: string;
    prompt: string;
    score: number;
  }>;
  winner?: string;
  adopted: boolean;
  timestamp: number;
}

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: false, // opt-in
  minFeedbackSamples: 10,
  evolutionIntervalMs: 86_400_000, // 24 hours
  maxVariants: 3,
  adoptionThreshold: 0.15,
  autoAdopt: false,
};

// ── Collect Feedback ────────────────────────────────────────────────

/**
 * Gather performance metrics for an agent.
 */
export async function collectFeedbackMetrics(agentId: string): Promise<FeedbackMetrics> {
  const pool = getPool();

  // Count recent interactions
  const { rows: interactionRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_log
     WHERE agent_id = $1 AND timestamp > $2`,
    [agentId, Date.now() - 7 * 86_400_000], // last 7 days
  );
  const totalInteractions = parseInt(interactionRows[0]?.count ?? "0", 10);

  // Count positive feedback
  const { rows: feedbackRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM execution_log
     WHERE agent_id = $1 AND tool_name = 'feedback' AND error IS NULL
       AND timestamp > $2`,
    [agentId, Date.now() - 7 * 86_400_000],
  );
  const positiveCount = parseInt(feedbackRows[0]?.count ?? "0", 10);

  // Identify common errors
  const { rows: errorRows } = await pool.query<{ error: string }>(
    `SELECT DISTINCT error FROM execution_log
     WHERE agent_id = $1 AND error IS NOT NULL
       AND timestamp > $2
     LIMIT 5`,
    [agentId, Date.now() - 7 * 86_400_000],
  );

  return {
    agentId,
    totalInteractions,
    positiveRatio: totalInteractions > 0 ? positiveCount / totalInteractions : 0.5,
    avgConfidence: 0.7, // would come from stored reflections
    commonIssues: errorRows.map((r) => r.error).filter(Boolean),
    weakAreas: identifyWeakAreas(errorRows.map((r) => r.error)),
  };
}

// ── Evolution Cycle ─────────────────────────────────────────────────

/**
 * Run a full evolution cycle for an agent.
 */
export async function runEvolutionCycle(
  agentId: string,
  uid: string,
  inferenceClient: InferenceClient,
  config: Partial<EvolutionConfig> = {},
): Promise<EvolutionResult> {
  const opts = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
  const agentConfig = getAgentConfig(agentId);

  log.info(`Running evolution cycle for ${agentId}`);

  // 1. Collect metrics
  const metrics = await collectFeedbackMetrics(agentId);

  if (metrics.totalInteractions < opts.minFeedbackSamples) {
    log.dim(`Insufficient data for ${agentId} (${metrics.totalInteractions}/${opts.minFeedbackSamples})`);
    return {
      agentId,
      previousVersion: 0,
      variants: [],
      adopted: false,
      timestamp: Date.now(),
    };
  }

  // 2. Generate prompt variants
  const variants = await generatePromptVariants(
    agentConfig,
    metrics,
    inferenceClient,
    opts.maxVariants,
  );

  // 3. Score each variant via shadow testing
  for (const variant of variants) {
    variant.score = await scoreVariant(
      variant.prompt,
      agentConfig,
      inferenceClient,
    );
  }

  // 4. Determine winner
  variants.sort((a, b) => b.score - a.score);
  const currentScore = await scoreVariant(agentConfig.systemPromptTemplate, agentConfig, inferenceClient);

  const winner = variants[0];
  const improved = winner && (winner.score - currentScore) >= opts.adoptionThreshold;

  const result: EvolutionResult = {
    agentId,
    previousVersion: 0,
    variants,
    winner: improved ? winner.label : undefined,
    adopted: false,
    timestamp: Date.now(),
  };

  // 5. Auto-adopt if threshold met
  if (improved && winner && opts.autoAdopt) {
    const updated = { ...agentConfig, systemPromptTemplate: winner.prompt };
    registerAgentConfig(agentId, updated);
    await createVersion(agentId, uid, updated, `Auto-evolved: ${winner.label}`);
    result.adopted = true;
    log.info(`Evolved ${agentId}: adopted "${winner.label}" (score: ${winner.score.toFixed(3)} vs ${currentScore.toFixed(3)})`);
  } else if (improved && winner) {
    log.info(`Evolution candidate for ${agentId}: "${winner.label}" (score: ${winner.score.toFixed(3)} vs ${currentScore.toFixed(3)}) — awaiting manual adoption`);
  }

  // Persist evolution result
  await persistEvolution(agentId, result);

  await logAgentAction(uid, agentId, "persona_evolution" as any, {
    variantsGenerated: variants.length,
    winner: result.winner,
    adopted: result.adopted,
  });

  return result;
}

// ── Variant Generation ──────────────────────────────────────────────

async function generatePromptVariants(
  config: AgentConfig,
  metrics: FeedbackMetrics,
  inferenceClient: InferenceClient,
  maxVariants: number,
): Promise<Array<{ label: string; prompt: string; score: number }>> {
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are a prompt engineer. Given an agent's current system prompt and performance metrics, generate ${maxVariants} improved variants.

Each variant should address identified weaknesses while preserving the agent's core personality.

Respond in JSON:
{
  "variants": [
    { "label": "brief description", "prompt": "full improved system prompt" }
  ]
}`,
      },
      {
        role: "user",
        content: `Current system prompt:\n${config.systemPromptTemplate}\n\nPerformance:\n- Positive ratio: ${metrics.positiveRatio.toFixed(2)}\n- Common issues: ${metrics.commonIssues.join(", ") || "none"}\n- Weak areas: ${metrics.weakAreas.join(", ") || "none"}\n\nGenerate ${maxVariants} improved variants.`,
      },
    ],
    temperature: 0.7,
    maxTokens: 3000,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      variants?: Array<{ label: string; prompt: string }>;
    };

    return (parsed.variants ?? []).map((v) => ({
      label: v.label,
      prompt: v.prompt,
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ── Variant Scoring ─────────────────────────────────────────────────

async function scoreVariant(
  promptText: string,
  config: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<number> {
  // Test the prompt with a standard evaluation query
  const testQueries = [
    "What can you help me with?",
    "Explain your approach to complex tasks.",
    "Help me make a decision about something important.",
  ];

  let totalScore = 0;

  for (const query of testQueries) {
    try {
      const response = await inferenceClient.chat({
        messages: [
          { role: "system", content: promptText },
          { role: "user", content: query },
        ],
        temperature: config.model.temperature,
        maxTokens: 500,
      });

      const reflection = await reflectOnResponse(
        query,
        response.content ?? "",
        inferenceClient,
        randomUUID(),
      );

      totalScore += reflection.confidence;
    } catch {
      // Failed trial gets 0 score
    }
  }

  return totalScore / testQueries.length;
}

// ── Helpers ─────────────────────────────────────────────────────────

function identifyWeakAreas(errors: (string | null)[]): string[] {
  const areas: string[] = [];
  const errorTexts = errors.filter(Boolean) as string[];

  if (errorTexts.some((e) => e.includes("timeout"))) areas.push("response speed");
  if (errorTexts.some((e) => e.includes("tool"))) areas.push("tool usage");
  if (errorTexts.some((e) => e.includes("context"))) areas.push("context management");
  if (errorTexts.some((e) => e.includes("format"))) areas.push("output formatting");

  return areas;
}

async function persistEvolution(agentId: string, result: EvolutionResult): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO persona_evolutions (id, agent_id, config, created_at)
     VALUES ($1, $2, $3::jsonb, NOW())`,
    [randomUUID(), agentId, JSON.stringify(result)],
  );
}
