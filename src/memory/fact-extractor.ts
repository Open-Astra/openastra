// ── Structured Fact Extraction ────────────────────────────────────────
// Extracts structured facts from text using regex + heuristics.
// Facts are typed: date, name, quantity, location, preference, constraint.

export type FactType = "date" | "name" | "quantity" | "location" | "preference" | "constraint";

export interface ExtractedFact {
  type: FactType;
  value: string;
  confidence: number;
  raw: string;
}

interface FactPattern {
  type: FactType;
  regex: RegExp;
  confidence: number;
  extract: (match: RegExpMatchArray) => string;
}

const FACT_PATTERNS: FactPattern[] = [
  {
    type: "date",
    regex: /\b(today|tomorrow|yesterday|on\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?|next\s+\w+|\d{4}-\d{2}-\d{2}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s+\d{4})?)\b/gi,
    confidence: 0.85,
    extract: (m) => m[1],
  },
  {
    type: "quantity",
    regex: /\b(\d+(?:\.\d+)?)\s*(items?|units?|dollars?|\$|%|kg|lbs?|hours?|days?|weeks?|months?|minutes?|seconds?|km|miles?|gb|mb|kb|ms)\b/gi,
    confidence: 0.9,
    extract: (m) => `${m[1]} ${m[2]}`,
  },
  {
    type: "preference",
    regex: /\b(prefer|like|love|hate|dislike|want|need|require|enjoy|avoid|favor)\b(.{0,50})/gi,
    confidence: 0.75,
    extract: (m) => `${m[1]}${m[2]}`.trim(),
  },
  {
    type: "constraint",
    regex: /\b(must\s+not|must|cannot|can not|should\s+not|always|never|required|mandatory|forbidden|prohibited)\b(.{0,60})/gi,
    confidence: 0.8,
    extract: (m) => `${m[1]}${m[2]}`.trim(),
  },
  {
    type: "location",
    regex: /\b(?:in|at|from|near|to)\s+([A-Z][a-zA-Z\s]{2,30}(?:,\s*[A-Z][a-zA-Z\s]{2,20})?)\b/g,
    confidence: 0.65,
    extract: (m) => m[1].trim(),
  },
  {
    type: "name",
    regex: /\b(?:called|named|my\s+name\s+is|i\s+am|this\s+is)\s+([A-Z][a-zA-Z\s]{1,30})\b/g,
    confidence: 0.7,
    extract: (m) => m[1].trim(),
  },
];

export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  for (const pattern of FACT_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpMatchArray | null;

    while ((match = regex.exec(text)) !== null) {
      const value = pattern.extract(match);
      if (!value || value.length < 2) continue;

      // Avoid exact duplicate (same type + value)
      const isDuplicate = facts.some(
        (f) => f.type === pattern.type && f.value.toLowerCase() === value.toLowerCase(),
      );
      if (isDuplicate) continue;

      facts.push({
        type: pattern.type,
        value,
        confidence: pattern.confidence,
        raw: match[0],
      });
    }
  }

  // Sort by confidence descending
  facts.sort((a, b) => b.confidence - a.confidence);

  return facts;
}
