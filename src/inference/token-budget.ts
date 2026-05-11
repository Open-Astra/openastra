import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Token Budget Tracker ────────────────────────────────────────────
// Tracks token consumption per user, agent, and session. Enables
// cost-aware routing, usage alerts, and billing-tier enforcement.
//
// Schema: token_usage table with per-request entries, aggregated
// into daily summaries for efficient querying.

const log = createLogger("token-budget");

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS token_usage (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_uid ON token_usage(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, created_at);

CREATE TABLE IF NOT EXISTS token_budgets (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  daily_limit INTEGER DEFAULT 500000,
  monthly_limit INTEGER DEFAULT 10000000,
  alert_threshold NUMERIC(3,2) DEFAULT 0.80,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)`;

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await getPool().query(ENSURE_TABLE);
  tableReady = true;
}

// Approximate costs per 1K tokens (input/output)
const COST_TABLE: Record<string, { input: number; output: number }> = {
  "grok-3": { input: 0.003, output: 0.015 },
  "grok-3-mini": { input: 0.0003, output: 0.0005 },
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015 },
  "claude-haiku-3-5": { input: 0.0008, output: 0.004 },
  "gemini-2.0-flash": { input: 0.0001, output: 0.0004 },
  "ollama": { input: 0, output: 0 }, // Local = free
};

function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
): number {
  // Match model ID to cost table (prefix match)
  let costs = COST_TABLE.ollama!;
  for (const [key, val] of Object.entries(COST_TABLE)) {
    if (modelId.includes(key) || key.includes(modelId)) {
      costs = val;
      break;
    }
  }

  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  const cachedCost = cachedTokens * costs.input * 0.5 / 1000; // 50% discount for cached
  return (billablePrompt * costs.input / 1000) + (completionTokens * costs.output / 1000) + cachedCost;
}

export interface TokenUsageEntry {
  uid: string;
  agentId: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/**
 * Record token usage for a single inference request.
 */
export async function recordTokenUsage(entry: TokenUsageEntry): Promise<void> {
  await ensureTable();

  const cost = estimateCost(
    entry.modelId,
    entry.promptTokens,
    entry.completionTokens,
    entry.cachedTokens,
  );

  await getPool().query(
    `INSERT INTO token_usage (uid, agent_id, session_id, provider, model_id, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entry.uid, entry.agentId, entry.sessionId ?? null, entry.provider, entry.modelId,
     entry.promptTokens, entry.completionTokens, entry.cachedTokens, cost],
  );
}

/**
 * Get token usage summary for a user over a time period.
 */
export async function getUsageSummary(
  uid: string,
  period: "day" | "week" | "month" = "day",
): Promise<{
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
  byModel: Array<{ modelId: string; tokens: number; cost: number }>;
  byAgent: Array<{ agentId: string; tokens: number }>;
}> {
  await ensureTable();

  const intervals = { day: "1 day", week: "7 days", month: "30 days" };
  const interval = intervals[period];

  const result = await getPool().query<{
    total_tokens: string;
    prompt_tokens: string;
    completion_tokens: string;
    cached_tokens: string;
    estimated_cost: string;
    request_count: string;
  }>(
    `SELECT
       SUM(prompt_tokens + completion_tokens) AS total_tokens,
       SUM(prompt_tokens) AS prompt_tokens,
       SUM(completion_tokens) AS completion_tokens,
       SUM(cached_tokens) AS cached_tokens,
       SUM(estimated_cost_usd) AS estimated_cost,
       COUNT(*) AS request_count
     FROM token_usage
     WHERE uid = $1 AND created_at >= NOW() - $2::interval`,
    [uid, interval],
  );

  const byModel = await getPool().query<{
    model_id: string;
    tokens: string;
    cost: string;
  }>(
    `SELECT model_id, SUM(prompt_tokens + completion_tokens) AS tokens, SUM(estimated_cost_usd) AS cost
     FROM token_usage WHERE uid = $1 AND created_at >= NOW() - $2::interval
     GROUP BY model_id ORDER BY tokens DESC`,
    [uid, interval],
  );

  const byAgent = await getPool().query<{
    agent_id: string;
    tokens: string;
  }>(
    `SELECT agent_id, SUM(prompt_tokens + completion_tokens) AS tokens
     FROM token_usage WHERE uid = $1 AND created_at >= NOW() - $2::interval
     GROUP BY agent_id ORDER BY tokens DESC`,
    [uid, interval],
  );

  const row = result.rows[0]!;
  return {
    totalTokens: parseInt(row.total_tokens ?? "0", 10),
    promptTokens: parseInt(row.prompt_tokens ?? "0", 10),
    completionTokens: parseInt(row.completion_tokens ?? "0", 10),
    cachedTokens: parseInt(row.cached_tokens ?? "0", 10),
    estimatedCostUsd: parseFloat(row.estimated_cost ?? "0"),
    requestCount: parseInt(row.request_count ?? "0", 10),
    byModel: byModel.rows.map((r) => ({
      modelId: r.model_id,
      tokens: parseInt(r.tokens, 10),
      cost: parseFloat(r.cost),
    })),
    byAgent: byAgent.rows.map((r) => ({
      agentId: r.agent_id,
      tokens: parseInt(r.tokens, 10),
    })),
  };
}

/**
 * Check if a user is within their token budget.
 */
export async function checkBudget(uid: string): Promise<{
  withinBudget: boolean;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  usagePercent: number;
}> {
  await ensureTable();

  // Get budget limits
  const budgetResult = await getPool().query<{
    daily_limit: number;
    monthly_limit: number;
    alert_threshold: number;
  }>(
    `SELECT daily_limit, monthly_limit, alert_threshold FROM token_budgets WHERE uid = $1`,
    [uid],
  );

  const budget = budgetResult.rows[0] ?? { daily_limit: 500_000, monthly_limit: 10_000_000, alert_threshold: 0.8 };

  // Get current usage
  const dailyResult = await getPool().query<{ tokens: string }>(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
     FROM token_usage WHERE uid = $1 AND created_at >= NOW() - INTERVAL '1 day'`,
    [uid],
  );

  const monthlyResult = await getPool().query<{ tokens: string }>(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
     FROM token_usage WHERE uid = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
    [uid],
  );

  const dailyUsed = parseInt(dailyResult.rows[0]?.tokens ?? "0", 10);
  const monthlyUsed = parseInt(monthlyResult.rows[0]?.tokens ?? "0", 10);

  const withinBudget = dailyUsed < budget.daily_limit && monthlyUsed < budget.monthly_limit;
  const usagePercent = Math.max(dailyUsed / budget.daily_limit, monthlyUsed / budget.monthly_limit);

  if (usagePercent >= budget.alert_threshold) {
    log.warn(`User ${uid} at ${Math.round(usagePercent * 100)}% of token budget`);
  }

  return {
    withinBudget,
    dailyUsed,
    dailyLimit: budget.daily_limit,
    monthlyUsed,
    monthlyLimit: budget.monthly_limit,
    usagePercent: Math.round(usagePercent * 100) / 100,
  };
}
