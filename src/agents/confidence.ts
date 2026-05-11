// ── Confidence Signal Extraction ────────────────────────────────────
// Analyzes an agent response for linguistic hedging and confidence markers.
// Returns a score between 0.1 (very uncertain) and 1.0 (very confident).

const HEDGE_PHRASES = [
  /\bi'?m\s+not\s+sure\b/i,
  /\bperhaps\b/i,
  /\bmaybe\b/i,
  /\bapproximately\b/i,
  /\broughly\b/i,
  /\bi\s+think\b/i,
  /\bpossibly\b/i,
  /\bit\s+seems\b/i,
  /\bcould\s+be\b/i,
  /\bmight\s+be\b/i,
  /\buncertain\b/i,
  /\bi\s+believe\b/i,
  /\bi'?d\s+estimate\b/i,
];

const CONFIDENT_PHRASES = [
  /\bdefinitely\b/i,
  /\bcertainly\b/i,
  /\babsolutely\b/i,
  /\bconfirmed\b/i,
  /\bprecisely\b/i,
  /\bexactly\b/i,
];

/**
 * Extract a confidence score from a response string.
 * Baseline is 0.7. Hedge phrases reduce it by 0.05 each (max -0.4).
 * Confident phrases increase it by 0.05 each (max +0.2).
 * Result is clamped between 0.1 and 1.0.
 */
export function extractConfidenceSignals(response: string): number {
  const baseline = 0.7;

  let hedgePenalty = 0;
  for (const pattern of HEDGE_PHRASES) {
    if (pattern.test(response)) {
      hedgePenalty += 0.05;
    }
  }
  hedgePenalty = Math.min(hedgePenalty, 0.4);

  let confidenceBoost = 0;
  for (const pattern of CONFIDENT_PHRASES) {
    if (pattern.test(response)) {
      confidenceBoost += 0.05;
    }
  }
  confidenceBoost = Math.min(confidenceBoost, 0.2);

  const score = baseline - hedgePenalty + confidenceBoost;
  return Math.min(1.0, Math.max(0.1, score));
}
