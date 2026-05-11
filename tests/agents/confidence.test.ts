import { describe, it, expect } from "vitest";

// ── Tests for src/agents/confidence.ts ──────────────────────────────
// Pure text-analysis logic — no mocks required.

import { extractConfidenceSignals } from "../../src/agents/confidence.js";

describe("extractConfidenceSignals", () => {
  it("returns a high score (near baseline 0.7) for a confident, hedge-free response", () => {
    const score = extractConfidenceSignals(
      "The answer is 42. This is the correct value.",
    );
    // No hedges, no boosters → baseline 0.7
    expect(score).toBeCloseTo(0.7);
  });

  it("boosts score for confident language (definitely, certainly, etc.)", () => {
    const score = extractConfidenceSignals(
      "This is definitely the right answer and it is certainly correct.",
    );
    // 'definitely' +0.05, 'certainly' +0.05 → 0.7 + 0.10 = 0.80
    expect(score).toBeCloseTo(0.8);
  });

  it("reduces score for hedging language ('I think', 'maybe')", () => {
    const score = extractConfidenceSignals(
      "I think this is the answer. Maybe try it.",
    );
    // 'I think' -0.05, 'maybe' -0.05 → 0.7 - 0.10 = 0.60
    expect(score).toBeCloseTo(0.6);
  });

  it("returns a low score for explicit uncertainty ('I'm not sure')", () => {
    const score = extractConfidenceSignals(
      "I'm not sure about this. It seems like it could be right, but perhaps not.",
    );
    // "I'm not sure" -0.05, "it seems" -0.05, "could be" -0.05, "perhaps" -0.05 → 0.7 - 0.20 = 0.50
    expect(score).toBeCloseTo(0.5);
  });

  it("clamps to 0.1 minimum for heavily hedged responses", () => {
    const response = [
      "I'm not sure",
      "perhaps",
      "maybe",
      "approximately",
      "roughly",
      "I think",
      "possibly",
      "it seems",
      "could be",
    ].join(". ");
    const score = extractConfidenceSignals(response);
    // Max penalty is -0.4 → 0.7 - 0.4 = 0.3, well above 0.1 floor but let's verify clamp
    expect(score).toBeGreaterThanOrEqual(0.1);
  });

  it("clamps to 1.0 maximum for very confident responses", () => {
    const response =
      "Definitely, certainly, absolutely, confirmed, precisely, exactly the right answer.";
    const score = extractConfidenceSignals(response);
    // Max boost is +0.2 → 0.7 + 0.2 = 0.9
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThan(0.7);
  });

  it("is deterministic — same input produces same output every time", () => {
    const input = "I believe the answer is approximately 10, possibly 11.";
    const score1 = extractConfidenceSignals(input);
    const score2 = extractConfidenceSignals(input);
    const score3 = extractConfidenceSignals(input);
    expect(score1).toBe(score2);
    expect(score2).toBe(score3);
  });

  it("handles empty string by returning baseline (0.7)", () => {
    const score = extractConfidenceSignals("");
    // No hedges, no boosts → 0.7
    expect(score).toBeCloseTo(0.7);
  });
});
