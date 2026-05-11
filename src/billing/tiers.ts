import { z } from "zod";

// ── User Tiers ──────────────────────────────────────────────────────

export const UserTier = z.enum(["free", "pro", "enterprise"]);
export type UserTier = z.infer<typeof UserTier>;

// ── Tier Configuration ──────────────────────────────────────────────

export interface TierConfig {
  tier: UserTier;
  monthlyTokenLimit: number;
  softCapPercent: number; // at this %, downgrade model
  downgradeModel: string | null; // null = no downgrade (enterprise)
  maxRequestsPerMinute: number;
}

export const TIER_CONFIGS: Record<UserTier, TierConfig> = {
  free: {
    tier: "free",
    monthlyTokenLimit: 100_000,
    softCapPercent: 0.8,
    downgradeModel: "gpt-4o-mini",
    maxRequestsPerMinute: 30,
  },
  pro: {
    tier: "pro",
    monthlyTokenLimit: 2_000_000,
    softCapPercent: 0.9,
    downgradeModel: "grok-4-1-fast-non-reasoning",
    maxRequestsPerMinute: 60,
  },
  enterprise: {
    tier: "enterprise",
    monthlyTokenLimit: 20_000_000,
    softCapPercent: 0.95,
    downgradeModel: null,
    maxRequestsPerMinute: 120,
  },
};

export function getTierConfig(tier: UserTier): TierConfig {
  return TIER_CONFIGS[tier];
}
