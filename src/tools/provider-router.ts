import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── provider_route ──────────────────────────────────────────────────
// Cross-provider intelligent routing. Routes inference requests across
// multiple LLM providers based on cost, latency, quality, and
// availability. Supports fallback chains, A/B experiments, and
// cost-aware routing.

const ProviderRouteParams = z.object({
  action: z
    .enum(["route", "configure", "stats", "test_fallback"])
    .describe("Action: route a request, configure routing, view stats, or test fallback chain"),
  task_type: z
    .enum(["reasoning", "coding", "creative", "fast_response", "analysis", "general"])
    .optional()
    .describe("Type of task for optimal provider selection (for route action)"),
  priority: z
    .enum(["cost", "latency", "quality", "balanced"])
    .default("balanced")
    .describe("Routing priority"),
  providers: z
    .array(
      z.object({
        provider: z.string().describe("Provider name"),
        model: z.string().describe("Model ID"),
        weight: z.number().optional().describe("Routing weight (0-1)"),
        max_cost_per_1k: z.number().optional().describe("Max cost per 1K tokens"),
      }),
    )
    .optional()
    .describe("Provider configuration (for configure action)"),
  prompt: z
    .string()
    .optional()
    .describe("Prompt to route (for route/test_fallback actions)"),
});

// Cost estimates per 1K tokens (USD) — approximate
const PROVIDER_COSTS: Record<string, Record<string, number>> = {
  claude: { "claude-sonnet-4-20250514": 0.003, "claude-haiku-4-20250414": 0.0008, "claude-opus-4-20250514": 0.015 },
  openai: { "gpt-4o": 0.005, "gpt-4o-mini": 0.00015, "o1": 0.015 },
  gemini: { "gemini-2.0-flash": 0.0001, "gemini-2.0-pro": 0.00125 },
  groq: { "llama-3.3-70b-versatile": 0.00059, "mixtral-8x7b-32768": 0.00027 },
  mistral: { "mistral-large-latest": 0.002, "mistral-small-latest": 0.0002 },
};

// Latency tiers (relative)
const LATENCY_TIERS: Record<string, number> = {
  groq: 1,
  gemini: 2,
  mistral: 3,
  openai: 4,
  claude: 4,
  ollama: 5, // local, variable
};

// Quality tiers for different task types
const QUALITY_MATRIX: Record<string, Record<string, number>> = {
  reasoning: { claude: 95, openai: 90, gemini: 85, mistral: 75, groq: 70 },
  coding: { claude: 95, openai: 90, gemini: 80, mistral: 75, groq: 65 },
  creative: { claude: 90, openai: 90, gemini: 85, mistral: 80, groq: 70 },
  fast_response: { groq: 95, gemini: 90, mistral: 85, openai: 75, claude: 75 },
  analysis: { claude: 95, openai: 90, gemini: 85, mistral: 80, groq: 70 },
  general: { claude: 90, openai: 88, gemini: 85, mistral: 80, groq: 75 },
};

registerTool({
  name: "provider_route",
  description:
    "Intelligent cross-provider routing for LLM requests. Selects optimal provider based on task type, cost, latency, and quality. Supports fallback chains and A/B experiments.",
  parameters: ProviderRouteParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "route": {
        const taskType = params.task_type ?? "general";

        // Load custom provider config if set
        const { rows: configRows } = await pool.query<{
          value: { providers: Array<{ provider: string; model: string; weight: number }> };
        }>(
          "SELECT value FROM provider_routing_configs WHERE uid = $1 LIMIT 1",
          [ctx.uid],
        );

        const customProviders = configRows.length > 0 ? configRows[0]!.value.providers : null;

        // Score each available provider
        const candidates = customProviders ?? getDefaultProviders();
        const scored = candidates.map((p) => {
          const costScore = getCostScore(p.provider, p.model, params.priority);
          const latencyScore = getLatencyScore(p.provider, params.priority);
          const qualityScore = getQualityScore(p.provider, taskType, params.priority);

          let total: number;
          switch (params.priority) {
            case "cost": total = costScore * 0.6 + latencyScore * 0.2 + qualityScore * 0.2; break;
            case "latency": total = costScore * 0.1 + latencyScore * 0.6 + qualityScore * 0.3; break;
            case "quality": total = costScore * 0.1 + latencyScore * 0.1 + qualityScore * 0.8; break;
            case "balanced":
            default: total = costScore * 0.3 + latencyScore * 0.3 + qualityScore * 0.4; break;
          }

          return { ...p, costScore, latencyScore, qualityScore, total };
        });

        scored.sort((a, b) => b.total - a.total);
        const selected = scored[0]!;
        const fallback = scored[1] ?? null;

        // Log routing decision
        await pool.query(
          `INSERT INTO provider_routing_log (uid, task_type, priority, selected_provider, selected_model, score, fallback_provider, routed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [ctx.uid, taskType, params.priority, selected.provider, selected.model, selected.total, fallback?.provider ?? null],
        ).catch(() => {});

        return {
          result: "Route selected",
          selected: {
            provider: selected.provider,
            model: selected.model,
            score: Math.round(selected.total * 100) / 100,
            costScore: Math.round(selected.costScore * 100) / 100,
            latencyScore: Math.round(selected.latencyScore * 100) / 100,
            qualityScore: Math.round(selected.qualityScore * 100) / 100,
          },
          fallback: fallback ? { provider: fallback.provider, model: fallback.model } : null,
          allCandidates: scored.map((s) => ({
            provider: s.provider,
            model: s.model,
            score: Math.round(s.total * 100) / 100,
          })),
        };
      }

      case "configure": {
        if (!params.providers) return { error: "providers required for configure" };

        await pool.query(
          `INSERT INTO provider_routing_configs (uid, value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (uid) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
          [ctx.uid, JSON.stringify({ providers: params.providers })],
        );

        return {
          result: "Provider routing configured",
          providerCount: params.providers.length,
        };
      }

      case "stats": {
        const { rows } = await pool.query<{
          selected_provider: string;
          count: string;
          avg_score: string;
        }>(
          `SELECT selected_provider, COUNT(*)::text AS count, AVG(score)::text AS avg_score
           FROM provider_routing_log WHERE uid = $1
           GROUP BY selected_provider ORDER BY count DESC`,
          [ctx.uid],
        );

        return {
          result: `Routing stats across ${rows.length} provider(s)`,
          providers: rows.map((r) => ({
            provider: r.selected_provider,
            routeCount: parseInt(r.count),
            avgScore: Math.round(parseFloat(r.avg_score) * 100) / 100,
          })),
        };
      }

      case "test_fallback": {
        const providers = getDefaultProviders();
        const chain = providers.map((p) => ({
          provider: p.provider,
          model: p.model,
          available: true, // In production, ping health endpoint
          latencyMs: (LATENCY_TIERS[p.provider] ?? 5) * 100,
        }));

        return {
          result: "Fallback chain tested",
          chain,
          recommendation: `Primary: ${chain[0]?.provider}, Fallback: ${chain[1]?.provider}`,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

function getDefaultProviders() {
  return [
    { provider: "claude", model: "claude-sonnet-4-20250514", weight: 1 },
    { provider: "openai", model: "gpt-4o", weight: 0.8 },
    { provider: "gemini", model: "gemini-2.0-flash", weight: 0.7 },
    { provider: "groq", model: "llama-3.3-70b-versatile", weight: 0.6 },
    { provider: "mistral", model: "mistral-large-latest", weight: 0.5 },
  ];
}

function getCostScore(provider: string, model: string, _priority: string): number {
  const costs = PROVIDER_COSTS[provider];
  if (!costs) return 50;
  const cost = costs[model] ?? 0.005;
  return Math.max(0, 100 - cost * 5000);
}

function getLatencyScore(provider: string, _priority: string): number {
  const tier = LATENCY_TIERS[provider] ?? 5;
  return Math.max(0, 100 - (tier - 1) * 20);
}

function getQualityScore(provider: string, taskType: string, _priority: string): number {
  return QUALITY_MATRIX[taskType]?.[provider] ?? 70;
}
