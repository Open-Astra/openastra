// ── Tone Drift Detection ──────────────────────────────────────────────
// Detects when agent responses drift from the expected tone by scoring
// keyword/phrase density for each tone category.

export type AgentTone = "formal" | "casual" | "technical" | "neutral";

export interface ToneDriftResult {
  drifted: boolean;
  expectedTone: AgentTone;
  actualTone: AgentTone;
  severity: "low" | "medium" | "high";
}

// ── Tone Keyword Maps ────────────────────────────────────────────────

const FORMAL_KEYWORDS = [
  "therefore", "consequently", "furthermore", "moreover", "however",
  "nevertheless", "pursuant", "henceforth", "accordingly", "thus",
  "wherein", "aforementioned", "subsequent", "regarding", "pertaining",
  "shall", "hereby", "duly", "whereas",
];

const CASUAL_KEYWORDS = [
  "hey", "cool", "awesome", "yeah", "yep", "nope", "gonna", "wanna",
  "kinda", "sorta", "stuff", "things", "ok", "okay", "lol", "btw",
  "basically", "literally", "totally", "pretty much", "you know",
  "like,", "super", "great!", "amazing!",
];

const TECHNICAL_KEYWORDS = [
  "function", "parameter", "algorithm", "implementation", "interface",
  "architecture", "latency", "throughput", "schema", "query", "endpoint",
  "async", "synchronous", "middleware", "api", "sdk", "dependency",
  "module", "namespace", "runtime", "compile", "deploy", "container",
  "configuration", "protocol", "payload", "authentication",
];

/**
 * Scores a block of text against each tone's keyword list.
 * Returns the tone with the highest relative keyword density.
 */
export function classifyTone(text: string): AgentTone {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).length;
  if (words === 0) return "neutral";

  const formalScore = FORMAL_KEYWORDS.filter((kw) => lower.includes(kw)).length / words;
  const casualScore = CASUAL_KEYWORDS.filter((kw) => lower.includes(kw)).length / words;
  const technicalScore = TECHNICAL_KEYWORDS.filter((kw) => lower.includes(kw)).length / words;

  const max = Math.max(formalScore, casualScore, technicalScore);

  // If no strong signal, classify as neutral
  if (max < 0.005) return "neutral";

  if (max === formalScore) return "formal";
  if (max === casualScore) return "casual";
  return "technical";
}

/**
 * Detects whether the actual response tone drifted from the expected tone.
 * Severity is based on how "far apart" the two tones are:
 *   - Same tone → no drift
 *   - Adjacent tones (e.g., formal vs neutral) → low
 *   - Opposite tones (e.g., formal vs casual) → high
 *   - Other mismatches → medium
 */
export function detectToneDrift(expected: AgentTone, actual: AgentTone): ToneDriftResult {
  if (expected === actual) {
    return { drifted: false, expectedTone: expected, actualTone: actual, severity: "low" };
  }

  // Determine severity by tone distance
  const opposites: Record<AgentTone, AgentTone> = {
    formal: "casual",
    casual: "formal",
    technical: "neutral",
    neutral: "technical",
  };

  let severity: "low" | "medium" | "high";
  if (actual === "neutral" || expected === "neutral") {
    severity = "low";
  } else if (opposites[expected] === actual) {
    severity = "high";
  } else {
    severity = "medium";
  }

  return {
    drifted: true,
    expectedTone: expected,
    actualTone: actual,
    severity,
  };
}
