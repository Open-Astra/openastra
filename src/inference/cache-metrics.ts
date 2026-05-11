import { getPool } from "../config/postgres.js";

// ── Provider Cache Metrics ───────────────────────────────────────────
// Logs and persists provider-side prompt cache hit rates.
// Stored in `provider_cache_metrics` (migration 178) for dashboard ROI views.

export interface CacheMetricsContext {
  agentId?: string;
  workspaceId?: string;
}

/**
 * Persist cache metrics to Postgres. Fire-and-forget — never throws.
 */
export function persistCacheMetrics(
  provider: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  },
  context?: CacheMetricsContext,
): void {
  getPool().query(
    `INSERT INTO provider_cache_metrics
       (provider, agent_id, workspace_id, prompt_tokens, cached_tokens, cache_creation_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      provider,
      context?.agentId ?? null,
      context?.workspaceId ?? null,
      usage.promptTokens,
      usage.cachedTokens ?? 0,
      usage.cacheCreationTokens ?? 0,
      usage.completionTokens,
    ],
  ).catch(() => {}); // never throw — metrics are best-effort
}

/**
 * Log cache hit metrics for a provider inference call.
 * Also persists to Postgres unconditionally (including misses) for dashboard ROI tracking.
 *
 * @param provider - Provider name (e.g. "claude", "openai")
 * @param usage    - Token usage from the inference response
 * @param context  - Optional agent/workspace context for per-agent metrics
 */
export function logCacheMetrics(
  provider: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  },
  context?: { agentId?: string; workspaceId?: string },
): void {
  // Always persist to DB — we want miss data too for ROI calculations
  persistCacheMetrics(provider, usage, context);

  if (!usage.cachedTokens || usage.cachedTokens === 0) {
    return;
  }

  // Standalone CLI shows cached tokens in the summary line — skip mid-stream logs
  if (process.env.ASTRA_STANDALONE) return;

  const hitRate = (usage.cachedTokens / usage.promptTokens) * 100;
  console.log(
    `[cache] ${provider}: ${usage.cachedTokens}/${usage.promptTokens} prompt tokens cached (${hitRate.toFixed(1)}%)`,
  );

  if (usage.cacheCreationTokens && usage.cacheCreationTokens > 0) {
    console.log(
      `[cache] ${provider}: ${usage.cacheCreationTokens} tokens written to cache`,
    );
  }
}

/**
 * Query aggregated cache metrics summary from the DB.
 *
 * @param provider - Optional provider filter (null = all providers)
 * @param hours    - Lookback window in hours (default: 24)
 */
export async function getCacheMetricsSummary(
  provider?: string,
  hours: number = 24,
): Promise<{ provider: string; avgHitRate: number; totalCachedTokens: number; callCount: number }[]> {
  const pool = getPool();
  const result = await pool.query<{
    provider: string;
    avg_hit_rate: string | null;
    total_cached_tokens: string | null;
    call_count: string;
  }>(
    `SELECT provider,
            AVG(hit_rate) AS avg_hit_rate,
            SUM(cached_tokens) AS total_cached_tokens,
            COUNT(*) AS call_count
     FROM provider_cache_metrics
     WHERE recorded_at > NOW() - ($1 || ' hours')::INTERVAL
       AND ($2::text IS NULL OR provider = $2)
     GROUP BY provider
     ORDER BY avg_hit_rate DESC`,
    [hours, provider ?? null],
  );

  return result.rows.map((row) => ({
    provider: row.provider,
    avgHitRate: row.avg_hit_rate !== null ? parseFloat(row.avg_hit_rate) : 0,
    totalCachedTokens: row.total_cached_tokens !== null ? parseInt(row.total_cached_tokens, 10) : 0,
    callCount: parseInt(row.call_count, 10),
  }));
}

/**
 * Get aggregate cache metrics for a provider/agent over the last N hours.
 * Opts-object variant — returns a single rolled-up row.
 */
export async function getCacheMetricsSummaryByOpts(
  opts: { provider?: string; agentId?: string; hoursBack?: number } = {},
): Promise<{
  totalCachedTokens: number;
  totalPromptTokens: number;
  avgHitRate: number;
  recordCount: number;
}> {
  const pool = getPool();
  const hoursBack = opts.hoursBack ?? 24;

  const conditions: string[] = [`recorded_at > NOW() - INTERVAL '1 hour' * $1`];
  const params: unknown[] = [hoursBack];

  if (opts.provider) {
    params.push(opts.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (opts.agentId) {
    params.push(opts.agentId);
    conditions.push(`agent_id = $${params.length}`);
  }

  const result = await pool.query<{
    total_cached: string;
    total_prompt: string;
    avg_hit_rate: string;
    record_count: string;
  }>(
    `SELECT
       COALESCE(SUM(cached_tokens), 0) AS total_cached,
       COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
       COALESCE(AVG(hit_rate), 0) AS avg_hit_rate,
       COUNT(*) AS record_count
     FROM provider_cache_metrics
     WHERE ${conditions.join(" AND ")}`,
    params,
  );

  const row = result.rows[0]!;
  return {
    totalCachedTokens: Number(row.total_cached),
    totalPromptTokens: Number(row.total_prompt),
    avgHitRate: Number(row.avg_hit_rate),
    recordCount: Number(row.record_count),
  };
}
