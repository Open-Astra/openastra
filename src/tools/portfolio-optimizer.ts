import { z } from "zod";
import { registerTool } from "./registry.js";

// ── portfolio_optimizer ────────────────────────────────────────────
// Builds a correlation-aware portfolio from a set of candidate bets.
// Calculates individual Kelly sizing, detects correlated legs, and
// caps total exposure at the user's risk threshold.
//
// Phase 3 stub: correlation detection is placeholder logic keyed on
// team/game overlap. Wire to the real correlation matrix when the
// 225-feature model ships historical covariance data.

const BetInput = z.object({
  playerName: z.string().describe("Player name for this bet"),
  market: z.string().describe("Prop market, e.g. 'points', 'rebounds', 'strikeouts'"),
  line: z.number().describe("The line/total for the prop"),
  direction: z.enum(["over", "under"]).describe("Bet direction"),
  probability: z
    .number()
    .min(0)
    .max(1)
    .describe("Model-estimated probability of hitting"),
  odds: z.number().describe("American odds, e.g. -110, +150"),
});

const PortfolioOptimizerParams = z.object({
  bets: z.array(BetInput).min(1).describe("Array of candidate bets to optimize"),
  bankroll: z.number().positive().describe("Current bankroll in dollars"),
  maxExposure: z
    .number()
    .min(0)
    .max(1)
    .default(0.15)
    .describe("Maximum total exposure as a fraction of bankroll (0-1)"),
  correlationAware: z
    .boolean()
    .default(true)
    .describe("Reduce sizing on correlated bets (same game/team)"),
});

// ── Mean-Variance Optimization (Markowitz) ──────────────────────────
// Simplified quadratic optimizer for portfolio weights.
// Finds weights that minimize variance for a target return,
// subject to: sum(weights) = 1, weights >= 0.

/**
 * Build a covariance matrix from bet data using a simple heuristic:
 * - Variance of each bet derived from Bernoulli variance: p*(1-p) * payout^2
 * - Correlation between same-player bets: 0.6
 * - Correlation between different bets: 0.1 (slight market correlation)
 */
function buildCovarianceMatrix(
  bets: z.infer<typeof BetInput>[],
  correlationGroups: Map<number, string>,
): number[][] {
  const n = bets.length;
  const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0) as number[]);

  for (let i = 0; i < n; i++) {
    const pi = bets[i].probability;
    const payoutI = americanToDecimal(bets[i].odds) - 1;
    const varI = pi * (1 - pi) * payoutI * payoutI;

    for (let j = 0; j < n; j++) {
      const pj = bets[j].probability;
      const payoutJ = americanToDecimal(bets[j].odds) - 1;
      const varJ = pj * (1 - pj) * payoutJ * payoutJ;

      if (i === j) {
        cov[i][j] = varI;
      } else {
        // Determine correlation based on grouping
        const groupI = correlationGroups.get(i);
        const groupJ = correlationGroups.get(j);
        const rho = (groupI && groupJ && groupI === groupJ) ? 0.6 : 0.1;
        cov[i][j] = rho * Math.sqrt(varI) * Math.sqrt(varJ);
      }
    }
  }

  return cov;
}

/**
 * Mean-variance optimization using gradient projection.
 * Iteratively adjusts weights to minimize portfolio variance
 * while targeting a specific expected return.
 *
 * Uses projected gradient descent with simplex constraints
 * (weights sum to 1, all >= 0).
 */
function meanVarianceOptimize(
  expectedReturns: number[],
  covMatrix: number[][],
  targetReturn: number | null,
  maxIterations: number = 500,
): number[] {
  const n = expectedReturns.length;
  if (n === 0) return [];
  if (n === 1) return [1.0];

  // Start with equal weights
  let weights = Array(n).fill(1 / n) as number[];

  const lr = 0.01; // learning rate

  for (let iter = 0; iter < maxIterations; iter++) {
    // Compute gradient of portfolio variance: 2 * Cov * w
    const grad = Array(n).fill(0) as number[];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        grad[i] += 2 * covMatrix[i][j] * weights[j];
      }
    }

    // If we have a target return, add penalty for deviating from it
    if (targetReturn !== null) {
      const currentReturn = weights.reduce((s, w, i) => s + w * expectedReturns[i], 0);
      const returnPenalty = 10 * (currentReturn - targetReturn);
      for (let i = 0; i < n; i++) {
        grad[i] += returnPenalty * expectedReturns[i];
      }
    }

    // Gradient step
    const newWeights = weights.map((w, i) => w - lr * grad[i]);

    // Project onto simplex: clamp negatives to 0, then normalize to sum=1
    for (let i = 0; i < n; i++) {
      newWeights[i] = Math.max(0, newWeights[i]);
    }
    const wSum = newWeights.reduce((s, w) => s + w, 0);
    if (wSum > 0) {
      for (let i = 0; i < n; i++) {
        newWeights[i] /= wSum;
      }
    } else {
      // Fallback to equal weights if all zeroed
      for (let i = 0; i < n; i++) {
        newWeights[i] = 1 / n;
      }
    }

    weights = newWeights;
  }

  return weights;
}

/**
 * Compute portfolio variance given weights and covariance matrix.
 */
function portfolioVariance(weights: number[], covMatrix: number[][]): number {
  const n = weights.length;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      variance += weights[i] * weights[j] * covMatrix[i][j];
    }
  }
  return variance;
}

// ── Types ──────────────────────────────────────────────────────────

interface SizedBet {
  playerName: string;
  market: string;
  line: number;
  direction: "over" | "under";
  probability: number;
  odds: number;
  kellyFraction: number;
  adjustedFraction: number;
  recommendedWager: number;
  correlationGroup: string | null;
}

interface PortfolioResult {
  bets: SizedBet[];
  totalExposure: number;
  totalExposurePct: number;
  diversificationScore: number;
  bankroll: number;
  warnings: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Convert American odds to decimal implied probability.
 * e.g. -110 → ~0.5238, +150 → ~0.4
 */
function americanToImpliedProbability(odds: number): number {
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

/**
 * Convert American odds to decimal payout multiplier.
 * e.g. -110 → 1.909, +150 → 2.5
 */
function americanToDecimal(odds: number): number {
  if (odds < 0) {
    return 1 + 100 / Math.abs(odds);
  }
  return 1 + odds / 100;
}

/**
 * Full Kelly fraction = (bp - q) / b
 * where b = net payout per dollar, p = true probability, q = 1 - p.
 * We use half-Kelly for practical bankroll management.
 */
function kellyFraction(probability: number, odds: number): number {
  const decimalOdds = americanToDecimal(odds);
  const b = decimalOdds - 1; // net payout per $1
  const p = probability;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;

  // Half-Kelly for practical risk management
  const halfKelly = fullKelly / 2;

  // Clamp: never negative (don't bet), never more than 10% on a single leg
  return Math.max(0, Math.min(halfKelly, 0.10));
}

/**
 * Detect correlation groups among bets.
 * TODO: Replace with real correlation matrix from the 225-feature model.
 * Current heuristic: bets on the same player are "same-player" correlated,
 * and we approximate same-game correlation by checking if player names
 * appear in the same market category for the same sport slate.
 */
function detectCorrelationGroups(
  bets: z.infer<typeof BetInput>[],
): Map<number, string> {
  const groups = new Map<number, string>();

  // Group by player name — multiple props on the same player are correlated
  const playerIndices = new Map<string, number[]>();
  for (let i = 0; i < bets.length; i++) {
    const key = bets[i].playerName.toLowerCase().trim();
    const existing = playerIndices.get(key) ?? [];
    existing.push(i);
    playerIndices.set(key, existing);
  }

  for (const [playerName, indices] of playerIndices) {
    if (indices.length > 1) {
      const groupId = `same-player:${playerName}`;
      for (const idx of indices) {
        groups.set(idx, groupId);
      }
    }
  }

  // TODO: Detect same-game correlations using game schedule data
  // TODO: Detect positional correlations (e.g. QB/WR stack)
  // TODO: Wire to covariance matrix from the 225-feature model

  return groups;
}

/**
 * Diversification score: 0-1 measure of how spread out the portfolio is.
 * 1.0 = perfectly diversified (equal sizing), 0.0 = all in one bet.
 * Uses normalized Herfindahl-Hirschman index.
 */
function diversificationScore(fractions: number[]): number {
  const nonZero = fractions.filter((f) => f > 0);
  if (nonZero.length <= 1) return 0;

  const total = nonZero.reduce((sum, f) => sum + f, 0);
  if (total === 0) return 0;

  const weights = nonZero.map((f) => f / total);
  const hhi = weights.reduce((sum, w) => sum + w * w, 0);
  const n = weights.length;

  // Normalize: HHI ranges from 1/n (perfect) to 1 (concentrated)
  // Score = (1 - HHI) / (1 - 1/n), inverted so 1 = diversified
  if (n === 1) return 0;
  return (1 - hhi) / (1 - 1 / n);
}

// ── Tool Registration ──────────────────────────────────────────────

registerTool({
  name: "portfolio_optimizer",
  description:
    "Build an optimized bet portfolio from candidate bets. Calculates Kelly-based sizing with correlation awareness and bankroll exposure limits. Returns recommended wager amounts and portfolio-level risk metrics.",
  parameters: PortfolioOptimizerParams,

  async execute(params) {
    const { bets, bankroll, maxExposure, correlationAware } = params;
    const warnings: string[] = [];

    // Step 1: Calculate individual Kelly fractions
    const correlationGroups = correlationAware
      ? detectCorrelationGroups(bets)
      : new Map<number, string>();

    const sizedBets: SizedBet[] = bets.map((bet, i) => {
      const kelly = kellyFraction(bet.probability, bet.odds);
      const group = correlationGroups.get(i) ?? null;

      return {
        playerName: bet.playerName,
        market: bet.market,
        line: bet.line,
        direction: bet.direction,
        probability: bet.probability,
        odds: bet.odds,
        kellyFraction: kelly,
        adjustedFraction: kelly, // will be adjusted below
        recommendedWager: 0, // computed after adjustments
        correlationGroup: group,
      };
    });

    // Step 2: Apply correlation discounts
    if (correlationAware) {
      // Group correlated bets and reduce their combined allocation
      const groupTotals = new Map<string, number[]>();
      for (let i = 0; i < sizedBets.length; i++) {
        const group = sizedBets[i].correlationGroup;
        if (group) {
          const indices = groupTotals.get(group) ?? [];
          indices.push(i);
          groupTotals.set(group, indices);
        }
      }

      for (const [_group, indices] of groupTotals) {
        // Reduce each correlated leg by 40% — conservative heuristic
        // TODO: Use actual correlation coefficients from the model
        const CORRELATION_DISCOUNT = 0.6;
        for (const idx of indices) {
          sizedBets[idx].adjustedFraction *= CORRELATION_DISCOUNT;
        }
      }
    }

    // Step 3: Cap total exposure at maxExposure
    let totalFraction = sizedBets.reduce((sum, b) => sum + b.adjustedFraction, 0);

    if (totalFraction > maxExposure) {
      const scaleFactor = maxExposure / totalFraction;
      for (const bet of sizedBets) {
        bet.adjustedFraction *= scaleFactor;
      }
      totalFraction = maxExposure;

      warnings.push(
        `Portfolio capped: raw exposure was ${(totalFraction / scaleFactor * 100).toFixed(1)}% of bankroll, reduced to ${(maxExposure * 100).toFixed(1)}% limit.`,
      );
    }

    // Step 4: Compute dollar wagers
    for (const bet of sizedBets) {
      bet.recommendedWager = Math.round(bet.adjustedFraction * bankroll * 100) / 100;
    }

    // Filter out zero-EV bets (Kelly = 0 means no edge)
    const zeroEdgeBets = sizedBets.filter((b) => b.kellyFraction === 0);
    if (zeroEdgeBets.length > 0) {
      warnings.push(
        `${zeroEdgeBets.length} bet(s) have no positive edge at the given odds — recommended $0 wager.`,
      );
    }

    // Step 5: Mean-Variance Optimization (Markowitz)
    // Compute expected returns per bet: E[R] = p * payout - (1-p) * 1
    const expectedReturns = bets.map((bet) => {
      const payout = americanToDecimal(bet.odds) - 1;
      return bet.probability * payout - (1 - bet.probability);
    });

    // Build covariance matrix
    const covMatrix = buildCovarianceMatrix(bets, correlationGroups);

    // Target return = weighted average of positive-edge bets' returns
    const positiveEdgeBets = expectedReturns.filter((r) => r > 0);
    const targetReturn = positiveEdgeBets.length > 0
      ? positiveEdgeBets.reduce((s, r) => s + r, 0) / positiveEdgeBets.length
      : null;

    // Run mean-variance optimization
    const mvWeights = meanVarianceOptimize(expectedReturns, covMatrix, targetReturn);

    // Compute portfolio metrics from MV weights
    const mvPortfolioReturn = mvWeights.reduce((s, w, i) => s + w * expectedReturns[i], 0);
    const mvPortfolioVariance = portfolioVariance(mvWeights, covMatrix);
    const mvPortfolioStdDev = Math.sqrt(Math.max(0, mvPortfolioVariance));
    const mvSharpeRatio = mvPortfolioStdDev > 0 ? mvPortfolioReturn / mvPortfolioStdDev : 0;

    // Blend MV weights with Kelly fractions: use MV for allocation ratios,
    // scale by total Kelly exposure to respect bankroll management
    for (let i = 0; i < sizedBets.length; i++) {
      // Only apply MV weight if the bet has positive edge
      if (sizedBets[i].kellyFraction > 0 && mvWeights[i] > 0) {
        sizedBets[i].adjustedFraction = sizedBets[i].adjustedFraction * 0.5 + mvWeights[i] * totalFraction * 0.5;
      }
    }

    // Re-cap total exposure after MV blending
    let postBlendTotal = sizedBets.reduce((sum, b) => sum + b.adjustedFraction, 0);
    if (postBlendTotal > maxExposure) {
      const scaleFactor = maxExposure / postBlendTotal;
      for (const bet of sizedBets) {
        bet.adjustedFraction *= scaleFactor;
      }
      postBlendTotal = maxExposure;
    }
    totalFraction = postBlendTotal;

    // Step 6: Compute dollar wagers (recompute after MV blending)
    for (const bet of sizedBets) {
      bet.recommendedWager = Math.round(bet.adjustedFraction * bankroll * 100) / 100;
    }

    // Step 7: Compute portfolio metrics
    const fractions = sizedBets.map((b) => b.adjustedFraction);
    const divScore = diversificationScore(fractions);
    const totalExposureDollars = sizedBets.reduce((sum, b) => sum + b.recommendedWager, 0);

    // Edge warnings
    for (const bet of sizedBets) {
      const implied = americanToImpliedProbability(bet.odds);
      if (bet.probability - implied < 0.02 && bet.kellyFraction > 0) {
        warnings.push(
          `${bet.playerName} ${bet.market}: thin edge (${((bet.probability - implied) * 100).toFixed(1)}% over implied). Consider passing.`,
        );
      }
    }

    const result: PortfolioResult = {
      bets: sizedBets,
      totalExposure: totalExposureDollars,
      totalExposurePct: totalFraction,
      diversificationScore: Math.round(divScore * 1000) / 1000,
      bankroll,
      warnings,
    };

    return {
      ...result,
      meanVarianceOptimization: {
        weights: mvWeights.map((w, i) => ({
          playerName: bets[i].playerName,
          market: bets[i].market,
          weight: Math.round(w * 10000) / 100,
        })),
        expectedPortfolioReturn: Math.round(mvPortfolioReturn * 10000) / 100,
        portfolioStdDev: Math.round(mvPortfolioStdDev * 10000) / 100,
        sharpeRatio: Math.round(mvSharpeRatio * 1000) / 1000,
        targetReturn: targetReturn !== null ? Math.round(targetReturn * 10000) / 100 : null,
      },
    };
  },
});

export type { SizedBet, PortfolioResult };
