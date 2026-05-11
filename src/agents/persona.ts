// ── Persona Context Detection ────────────────────────────────────────
// Detects the conversational context from a user message to allow adaptive
// persona overlays. Returns a named context or null if no match.

export type PersonaContext = "code_review" | "planning" | "support" | "research";

const PERSONA_PATTERNS: Array<{ context: PersonaContext; pattern: RegExp }> = [
  { context: "code_review", pattern: /\bcode\s*review\b|\bpr\s*review\b|\breview.*code\b/i },
  { context: "planning", pattern: /\bstrategy\b|\broadmap\b|\bsprint\b|\bbacklog\b|\bprioritize\b/i },
  { context: "support", pattern: /\bbug\b|\berror\b.*\bfix\b|\bnot\s*working\b|\bbroken\b/i },
  { context: "research", pattern: /\bresearch\b|\banalyze\b|\bcompare\b|\binvestigate\b/i },
];

/**
 * Detect a persona context from the given message.
 * Returns the first matching context name, or null if none match.
 */
export function detectPersonaContext(message: string): PersonaContext | null {
  for (const { context, pattern } of PERSONA_PATTERNS) {
    if (pattern.test(message)) {
      return context;
    }
  }
  return null;
}
