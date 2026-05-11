// ── Memory Importance Decay Scoring ─────────────────────────────────
// Combines recency decay, access frequency, and reinforcement to rank memories.

export interface DecayConfig {
  halfLifeDays: number;
  accessBonus: number;
  reinforcementWeight: number;
}

const DEFAULT_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  accessBonus: 0.05,
  reinforcementWeight: 0.2,
};

/**
 * Exponential decay: score = exp(-λ * ageDays) where λ = ln(2) / halfLife.
 */
function decayFactor(ageDays: number, halfLifeDays: number): number {
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

/**
 * Compute an importance score for a single memory entry.
 * Score is in [0, ∞) — higher is more important.
 */
export function computeImportanceScore(
  memory: {
    createdAt: Date;
    lastAccessedAt?: Date;
    accessCount: number;
    reinforcementScore?: number;
  },
  config: DecayConfig = DEFAULT_CONFIG,
): number {
  const now = Date.now();
  const ageMs = now - memory.createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const base = decayFactor(ageDays, config.halfLifeDays);
  const access = config.accessBonus * (memory.accessCount ?? 0);
  const reinforcement = config.reinforcementWeight * (memory.reinforcementScore ?? 0);

  return base + access + reinforcement;
}

/**
 * Sort memories by importance score (descending).
 */
export function rankMemoriesByImportance<T extends {
  created_at: string;
  access_count?: number;
  reinforcement_score?: number;
  last_accessed_at?: string;
}>(memories: T[], config: DecayConfig = DEFAULT_CONFIG): T[] {
  return [...memories].sort((a, b) => {
    const scoreA = computeImportanceScore({
      createdAt: new Date(a.created_at),
      accessCount: a.access_count ?? 0,
      reinforcementScore: a.reinforcement_score,
      lastAccessedAt: a.last_accessed_at ? new Date(a.last_accessed_at) : undefined,
    }, config);
    const scoreB = computeImportanceScore({
      createdAt: new Date(b.created_at),
      accessCount: b.access_count ?? 0,
      reinforcementScore: b.reinforcement_score,
      lastAccessedAt: b.last_accessed_at ? new Date(b.last_accessed_at) : undefined,
    }, config);
    return scoreB - scoreA;
  });
}

/**
 * Keep only the top N memories by importance score.
 */
export function pruneByImportance<T extends {
  created_at: string;
  access_count?: number;
  reinforcement_score?: number;
  last_accessed_at?: string;
}>(memories: T[], topN: number, config?: DecayConfig): T[] {
  return rankMemoriesByImportance(memories, config).slice(0, topN);
}
