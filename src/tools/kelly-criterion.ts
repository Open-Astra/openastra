import { z } from "zod";
import { registerTool } from "./registry.js";

// ── kelly_criterion ─────────────────────────────────────────────────
// Calculates optimal bet sizing using the Kelly Criterion.
//
// The classic Kelly formula gives the mathematically optimal fraction
// of bankroll to wager, but full Kelly is notoriously aggressive.
// Most sharp bettors use fractional Kelly (1/4 to 1/2) to reduce
// variance at the cost of slightly lower long-term growth.
//
// The implementation below needs the core sizing logic — this is
// where the risk model lives.

const KellyParams = z.object({
  bankroll: z.number().positive().describe("Current bankroll in dollars"),
  probability: z
    .number()
    .min(0)
    .max(1)
    .describe("Estimated probability of winning (0-1)"),
  odds: z
    .number()
    .describe("American odds (e.g., -110, +150)"),
  kellyFraction: z
    .number()
    .min(0.1)
    .max(1.0)
    .default(0.25)
    .describe("Kelly fraction to use (0.25 = quarter Kelly, 1.0 = full Kelly)"),
  maxBetPercent: z
    .number()
    .min(0.01)
    .max(0.2)
    .default(0.05)
    .describe("Maximum bet as percentage of bankroll (hard cap)"),
});

type KellyParams = z.infer<typeof KellyParams>;

// ── Core Kelly Logic ────────────────────────────────────────────────
//
// TODO: Implement calculateKellySizing
//
// This function takes the Kelly parameters and returns the recommended
// bet size. The math:
//
//   1. Convert American odds to decimal odds
//      - Positive odds: decimal = (odds / 100) + 1
//      - Negative odds: decimal = (100 / Math.abs(odds)) + 1
//
//   2. Calculate the edge using Kelly formula:
//      kellyPct = (probability * decimalOdds - 1) / (decimalOdds - 1)
//
//   3. Apply fractional Kelly:
//      adjustedPct = kellyPct * kellyFraction
//
//   4. Apply the hard cap (maxBetPercent) and floor at 0 (no bet if negative edge)
//
//   5. Return the dollar amount: bankroll * finalPct
//
// Consider: should negative edge return 0 or a small "minimum viable bet"
// for tracking purposes? How should you handle edge cases like -100 odds
// or probability = 1.0?

function calculateKellySizing(params: KellyParams): {
  recommendedBet: number;
  kellyPct: number;
  fullKellyPct: number;
  halfKellyPct: number;
  quarterKellyPct: number;
  halfKellyBet: number;
  quarterKellyBet: number;
  edge: number;
  decimalOdds: number;
  impliedProbability: number;
  expectedValue: number;
} {
  const { bankroll, probability, odds, kellyFraction, maxBetPercent } = params;

  // 1. Convert American odds to decimal
  const decimalOdds = odds > 0
    ? (odds / 100) + 1
    : (100 / Math.abs(odds)) + 1;

  // Implied probability from the odds (vig-inclusive)
  const impliedProbability = odds < 0
    ? Math.abs(odds) / (Math.abs(odds) + 100)
    : 100 / (odds + 100);

  // 2. Full Kelly formula: f* = (bp - q) / b
  // where b = decimalOdds - 1 (net payout per $1), p = probability, q = 1-p
  const b = decimalOdds - 1;
  const p = probability;
  const q = 1 - p;
  const fullKellyPct = b > 0 ? (b * p - q) / b : 0;

  // 3. Edge is the expected value as a fraction of the wager
  const edge = p * decimalOdds - 1;

  // Expected value per dollar wagered
  const expectedValue = p * b - q;

  // 4. Fractional Kelly variants — always floored at 0
  const halfKellyPct = Math.max(0, fullKellyPct * 0.5);
  const quarterKellyPct = Math.max(0, fullKellyPct * 0.25);

  // 5. Apply the user's chosen fraction + hard cap, floor at 0
  const adjustedPct = Math.max(0, Math.min(fullKellyPct * kellyFraction, maxBetPercent));

  // 6. Dollar amounts
  const recommendedBet = bankroll * adjustedPct;
  const halfKellyBet = bankroll * Math.min(halfKellyPct, maxBetPercent);
  const quarterKellyBet = bankroll * Math.min(quarterKellyPct, maxBetPercent);

  return {
    recommendedBet,
    kellyPct: adjustedPct,
    fullKellyPct: Math.max(0, fullKellyPct),
    halfKellyPct,
    quarterKellyPct,
    halfKellyBet,
    quarterKellyBet,
    edge,
    decimalOdds,
    impliedProbability,
    expectedValue,
  };
}

registerTool({
  name: "kelly_criterion",
  description:
    "Calculate optimal bet sizing using the Kelly Criterion. Takes the user's bankroll, estimated win probability, and odds to recommend a bet size. Uses fractional Kelly by default (quarter Kelly) for variance reduction.",
  parameters: KellyParams,

  async execute(params) {
    const result = calculateKellySizing(params);

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const pct = (n: number) => Math.round(n * 10000) / 100;

    return {
      recommendedBet: r2(result.recommendedBet),
      kellyPercentage: pct(result.kellyPct),
      fullKellyPercentage: pct(result.fullKellyPct),
      halfKellyPercentage: pct(result.halfKellyPct),
      quarterKellyPercentage: pct(result.quarterKellyPct),
      halfKellyBet: r2(result.halfKellyBet),
      quarterKellyBet: r2(result.quarterKellyBet),
      edge: pct(result.edge),
      expectedValuePerDollar: r2(result.expectedValue),
      decimalOdds: Math.round(result.decimalOdds * 1000) / 1000,
      impliedProbability: pct(result.impliedProbability),
      bankroll: params.bankroll,
      kellyFraction: params.kellyFraction,
      maxBetPercent: params.maxBetPercent,
      hasEdge: result.edge > 0,
      variants: {
        fullKelly: { percentage: pct(result.fullKellyPct), bet: r2(params.bankroll * Math.min(Math.max(0, result.fullKellyPct), params.maxBetPercent)) },
        halfKelly: { percentage: pct(result.halfKellyPct), bet: r2(result.halfKellyBet) },
        quarterKelly: { percentage: pct(result.quarterKellyPct), bet: r2(result.quarterKellyBet) },
      },
      message: result.edge > 0
        ? `Recommended bet: $${r2(result.recommendedBet)} (${pct(result.kellyPct)}% at ${params.kellyFraction}x Kelly). Full Kelly: ${pct(result.fullKellyPct)}%, Half: ${pct(result.halfKellyPct)}%, Quarter: ${pct(result.quarterKellyPct)}%. Edge: ${pct(result.edge)}%.`
        : `No positive edge detected (${pct(result.edge)}%). Kelly says no bet.`,
    };
  },
});
