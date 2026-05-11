import { getPool } from "../config/postgres.js";
import { getUsageSummary } from "./tracker.js";
import { getTierConfig, TIER_CONFIGS } from "./tiers.js";
import type { UserTier, TierConfig } from "./tiers.js";
import { fireWebhooksForEvent } from "../webhooks/dispatcher.js";

// ── Budget Check Result ─────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  degraded: boolean;
  overrideModel?: string;
  currentUsage: number;
  limit: number;
  tier: UserTier;
  reason?: string;
}

// ── In-Memory Tier Cache ────────────────────────────────────────────
// TTL cache for user tier to avoid DB reads on every request.

interface CachedTier {
  tier: UserTier;
  expiresAt: number;
}

const tierCache = new Map<string, CachedTier>();
const TIER_CACHE_TTL = 60_000; // 60s

async function getUserTier(uid: string): Promise<UserTier> {
  const cached = tierCache.get(uid);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tier;
  }

  const pool = getPool();
  const { rows } = await pool.query<{ tier: string }>(
    "SELECT tier FROM users WHERE id = $1",
    [uid],
  );

  let tier: UserTier = "free";
  if (rows.length > 0 && rows[0]!.tier in TIER_CONFIGS) {
    tier = rows[0]!.tier as UserTier;
  }

  tierCache.set(uid, { tier, expiresAt: Date.now() + TIER_CACHE_TTL });
  return tier;
}

// ── Budget Check ────────────────────────────────────────────────────

export async function checkTokenBudget(uid: string): Promise<BudgetCheckResult> {
  const tier = await getUserTier(uid);
  const config: TierConfig = getTierConfig(tier);
  const usage = await getUsageSummary(uid);

  const currentUsage = usage.totalTokens;
  const limit = config.monthlyTokenLimit;
  const softCap = limit * config.softCapPercent;

  // Hard cap — over 100% of limit
  if (currentUsage >= limit) {
    fireWebhooksForEvent(uid, "budget_hard_cap", { currentUsage, limit, tier }).catch(() => {});

    return {
      allowed: false,
      degraded: false,
      currentUsage,
      limit,
      tier,
      reason: `Monthly token limit reached (${currentUsage.toLocaleString()}/${limit.toLocaleString()}). Upgrade your plan for more tokens.`,
    };
  }

  // Soft cap — between softCapPercent and 100%
  if (currentUsage >= softCap && config.downgradeModel) {
    fireWebhooksForEvent(uid, "budget_soft_cap", { currentUsage, limit, tier, softCap }).catch(() => {});

    return {
      allowed: true,
      degraded: true,
      overrideModel: config.downgradeModel,
      currentUsage,
      limit,
      tier,
      reason: `Approaching token limit (${Math.round((currentUsage / limit) * 100)}%). Using efficient model to extend your budget.`,
    };
  }

  // Under soft cap — full access
  return {
    allowed: true,
    degraded: false,
    currentUsage,
    limit,
    tier,
  };
}
