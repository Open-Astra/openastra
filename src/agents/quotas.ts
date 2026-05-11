import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Resource Quotas per Agent / Spawn ───────────────────────────────
// Enforces hard limits on individual agents and spawn trees.
// Unlike budgets (per-swarm), quotas are persistent per-agent
// and reset on a configurable schedule (hourly/daily/monthly).
//
// Quota dimensions:
//   - Tokens per period
//   - API requests per period
//   - Spawn depth and count
//   - CPU time (tool execution)
//   - Concurrent active sessions

export const _log = createLogger("quotas");

// ── Types ───────────────────────────────────────────────────────────

export type QuotaPeriod = "hourly" | "daily" | "monthly";

export interface ResourceQuota {
  agentId: string;
  // Token limits
  maxTokensPerHour: number;
  maxTokensPerDay: number;
  maxTokensPerMonth: number;
  // Request limits
  maxRequestsPerMinute: number;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
  // Spawn limits
  maxSpawnDepth: number;
  maxConcurrentSpawns: number;
  maxSpawnsPerDay: number;
  // Execution limits
  maxToolCallsPerRequest: number;
  maxToolExecutionMs: number;       // max ms for a single tool call
  maxConcurrentSessions: number;
  // Cost limits (cents)
  maxCostPerDay: number;
  maxCostPerMonth: number;
}

export interface QuotaUsage {
  agentId: string;
  tokensThisHour: number;
  tokensThisDay: number;
  tokensThisMonth: number;
  requestsThisMinute: number;
  requestsThisHour: number;
  requestsThisDay: number;
  spawnsToday: number;
  activeSpawns: number;
  activeSessions: number;
  costTodayCents: number;
  costThisMonthCents: number;
  lastResetHour: string;
  lastResetDay: string;
  lastResetMonth: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  remaining?: {
    tokensHour: number;
    tokensDay: number;
    requestsMinute: number;
    requestsHour: number;
  };
}

// ── Default Quotas by Tier ──────────────────────────────────────────

export const TIER_QUOTAS: Record<string, Partial<ResourceQuota>> = {
  free: {
    maxTokensPerHour: 50_000,
    maxTokensPerDay: 200_000,
    maxTokensPerMonth: 2_000_000,
    maxRequestsPerMinute: 10,
    maxRequestsPerHour: 100,
    maxRequestsPerDay: 500,
    maxSpawnDepth: 1,
    maxConcurrentSpawns: 2,
    maxSpawnsPerDay: 10,
    maxToolCallsPerRequest: 5,
    maxToolExecutionMs: 10_000,
    maxConcurrentSessions: 3,
    maxCostPerDay: 50,        // $0.50
    maxCostPerMonth: 500,     // $5.00
  },
  premium: {
    maxTokensPerHour: 200_000,
    maxTokensPerDay: 1_000_000,
    maxTokensPerMonth: 20_000_000,
    maxRequestsPerMinute: 30,
    maxRequestsPerHour: 500,
    maxRequestsPerDay: 5_000,
    maxSpawnDepth: 3,
    maxConcurrentSpawns: 5,
    maxSpawnsPerDay: 100,
    maxToolCallsPerRequest: 15,
    maxToolExecutionMs: 30_000,
    maxConcurrentSessions: 10,
    maxCostPerDay: 500,       // $5.00
    maxCostPerMonth: 5_000,   // $50.00
  },
  internal: {
    maxTokensPerHour: 500_000,
    maxTokensPerDay: 5_000_000,
    maxTokensPerMonth: 50_000_000,
    maxRequestsPerMinute: 60,
    maxRequestsPerHour: 1_000,
    maxRequestsPerDay: 20_000,
    maxSpawnDepth: 5,
    maxConcurrentSpawns: 10,
    maxSpawnsPerDay: 500,
    maxToolCallsPerRequest: 30,
    maxToolExecutionMs: 60_000,
    maxConcurrentSessions: 50,
    maxCostPerDay: 5_000,     // $50.00
    maxCostPerMonth: 50_000,  // $500.00
  },
};

// ── Default Quota ───────────────────────────────────────────────────

const DEFAULT_QUOTA: ResourceQuota = {
  ...TIER_QUOTAS.premium as ResourceQuota,
  agentId: "default",
} as ResourceQuota;

// ── Quota Check ─────────────────────────────────────────────────────

/**
 * Check if an agent's current usage is within quota limits.
 */
export async function checkQuota(
  agentId: string,
  tier: string = "premium",
): Promise<QuotaCheckResult> {
  const quota = await getQuota(agentId, tier);
  const usage = await getUsage(agentId);

  // Auto-reset stale counters
  await maybeResetCounters(agentId, usage);

  if (usage.tokensThisHour >= quota.maxTokensPerHour) {
    return { allowed: false, reason: `Hourly token limit reached (${usage.tokensThisHour}/${quota.maxTokensPerHour})` };
  }
  if (usage.tokensThisDay >= quota.maxTokensPerDay) {
    return { allowed: false, reason: `Daily token limit reached (${usage.tokensThisDay}/${quota.maxTokensPerDay})` };
  }
  if (usage.requestsThisMinute >= quota.maxRequestsPerMinute) {
    return { allowed: false, reason: `Rate limit: ${quota.maxRequestsPerMinute} requests/min` };
  }
  if (usage.requestsThisHour >= quota.maxRequestsPerHour) {
    return { allowed: false, reason: `Hourly request limit reached` };
  }
  if (usage.costTodayCents >= quota.maxCostPerDay) {
    return { allowed: false, reason: `Daily cost limit reached ($${(usage.costTodayCents / 100).toFixed(2)})` };
  }

  return {
    allowed: true,
    remaining: {
      tokensHour: quota.maxTokensPerHour - usage.tokensThisHour,
      tokensDay: quota.maxTokensPerDay - usage.tokensThisDay,
      requestsMinute: quota.maxRequestsPerMinute - usage.requestsThisMinute,
      requestsHour: quota.maxRequestsPerHour - usage.requestsThisHour,
    },
  };
}

/**
 * Check spawn-specific quotas.
 */
export async function checkSpawnQuota(
  agentId: string,
  requestedDepth: number,
  tier: string = "premium",
): Promise<QuotaCheckResult> {
  const quota = await getQuota(agentId, tier);
  const usage = await getUsage(agentId);

  if (requestedDepth > quota.maxSpawnDepth) {
    return { allowed: false, reason: `Spawn depth ${requestedDepth} exceeds max ${quota.maxSpawnDepth}` };
  }
  if (usage.activeSpawns >= quota.maxConcurrentSpawns) {
    return { allowed: false, reason: `Max concurrent spawns reached (${quota.maxConcurrentSpawns})` };
  }
  if (usage.spawnsToday >= quota.maxSpawnsPerDay) {
    return { allowed: false, reason: `Daily spawn limit reached (${usage.spawnsToday}/${quota.maxSpawnsPerDay})` };
  }

  return { allowed: true };
}

// ── Record Usage ────────────────────────────────────────────────────

export async function recordTokenUsage(
  agentId: string,
  tokens: number,
  costCents: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO quota_usage (agent_id, tokens_hour, tokens_day, tokens_month, requests_minute, requests_hour, requests_day, cost_day_cents, cost_month_cents, updated_at)
     VALUES ($1, $2, $2, $2, 1, 1, 1, $3, $3, NOW())
     ON CONFLICT (agent_id)
     DO UPDATE SET
       tokens_hour = quota_usage.tokens_hour + $2,
       tokens_day = quota_usage.tokens_day + $2,
       tokens_month = quota_usage.tokens_month + $2,
       requests_minute = quota_usage.requests_minute + 1,
       requests_hour = quota_usage.requests_hour + 1,
       requests_day = quota_usage.requests_day + 1,
       cost_day_cents = quota_usage.cost_day_cents + $3,
       cost_month_cents = quota_usage.cost_month_cents + $3,
       updated_at = NOW()`,
    [agentId, tokens, costCents],
  );
}

export async function recordSpawnStart(agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO quota_usage (agent_id, active_spawns, spawns_day, updated_at)
     VALUES ($1, 1, 1, NOW())
     ON CONFLICT (agent_id)
     DO UPDATE SET active_spawns = quota_usage.active_spawns + 1, spawns_day = quota_usage.spawns_day + 1, updated_at = NOW()`,
    [agentId],
  );
}

export async function recordSpawnEnd(agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE quota_usage SET active_spawns = GREATEST(0, active_spawns - 1), updated_at = NOW() WHERE agent_id = $1`,
    [agentId],
  );
}

// ── Quota CRUD ──────────────────────────────────────────────────────

export async function setQuota(
  agentId: string,
  overrides: Partial<ResourceQuota>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO quota_configs (agent_id, config, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (agent_id)
     DO UPDATE SET config = $2::jsonb, updated_at = NOW()`,
    [agentId, JSON.stringify(overrides)],
  );
}

async function getQuota(agentId: string, tier: string): Promise<ResourceQuota> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: Partial<ResourceQuota> }>(
    "SELECT config FROM quota_configs WHERE agent_id = $1",
    [agentId],
  );

  const tierDefaults = TIER_QUOTAS[tier] ?? TIER_QUOTAS.premium!;
  const agentOverrides = rows[0]?.config ?? {};

  return { ...DEFAULT_QUOTA, ...tierDefaults, ...agentOverrides, agentId } as ResourceQuota;
}

async function getUsage(agentId: string): Promise<QuotaUsage> {
  const pool = getPool();
  const { rows } = await pool.query<{
    tokens_hour: number;
    tokens_day: number;
    tokens_month: number;
    requests_minute: number;
    requests_hour: number;
    requests_day: number;
    spawns_day: number;
    active_spawns: number;
    active_sessions: number;
    cost_day_cents: number;
    cost_month_cents: number;
    last_reset_hour: string;
    last_reset_day: string;
    last_reset_month: string;
  }>(
    "SELECT * FROM quota_usage WHERE agent_id = $1",
    [agentId],
  );

  if (rows.length === 0) {
    return {
      agentId,
      tokensThisHour: 0, tokensThisDay: 0, tokensThisMonth: 0,
      requestsThisMinute: 0, requestsThisHour: 0, requestsThisDay: 0,
      spawnsToday: 0, activeSpawns: 0, activeSessions: 0,
      costTodayCents: 0, costThisMonthCents: 0,
      lastResetHour: new Date().toISOString(),
      lastResetDay: new Date().toISOString().slice(0, 10),
      lastResetMonth: new Date().toISOString().slice(0, 7),
    };
  }

  const r = rows[0]!;
  return {
    agentId,
    tokensThisHour: r.tokens_hour ?? 0,
    tokensThisDay: r.tokens_day ?? 0,
    tokensThisMonth: r.tokens_month ?? 0,
    requestsThisMinute: r.requests_minute ?? 0,
    requestsThisHour: r.requests_hour ?? 0,
    requestsThisDay: r.requests_day ?? 0,
    spawnsToday: r.spawns_day ?? 0,
    activeSpawns: r.active_spawns ?? 0,
    activeSessions: r.active_sessions ?? 0,
    costTodayCents: r.cost_day_cents ?? 0,
    costThisMonthCents: r.cost_month_cents ?? 0,
    lastResetHour: r.last_reset_hour ?? new Date().toISOString(),
    lastResetDay: r.last_reset_day ?? new Date().toISOString().slice(0, 10),
    lastResetMonth: r.last_reset_month ?? new Date().toISOString().slice(0, 7),
  };
}

// ── Counter Resets ──────────────────────────────────────────────────

async function maybeResetCounters(agentId: string, usage: QuotaUsage): Promise<void> {
  const pool = getPool();
  const now = new Date();
  const currentHour = now.toISOString().slice(0, 13);
  const currentDay = now.toISOString().slice(0, 10);
  const currentMonth = now.toISOString().slice(0, 7);

  const resets: string[] = [];

  if (usage.lastResetHour.slice(0, 13) !== currentHour) {
    resets.push("tokens_hour = 0, requests_minute = 0, requests_hour = 0, last_reset_hour = NOW()::text");
  }
  if (usage.lastResetDay.slice(0, 10) !== currentDay) {
    resets.push("tokens_day = 0, requests_day = 0, spawns_day = 0, cost_day_cents = 0, last_reset_day = NOW()::text");
  }
  if (usage.lastResetMonth.slice(0, 7) !== currentMonth) {
    resets.push("tokens_month = 0, cost_month_cents = 0, last_reset_month = NOW()::text");
  }

  if (resets.length > 0) {
    await pool.query(
      `UPDATE quota_usage SET ${resets.join(", ")}, updated_at = NOW() WHERE agent_id = $1`,
      [agentId],
    );
  }
}
