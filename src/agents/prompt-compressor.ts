// ── Prompt Compression ────────────────────────────────────────────────
// Compresses long system prompts by removing low-importance sentences.
// Uses keyword density scoring to rank sentences; keeps the highest-scoring
// sentences until we fit within the target token budget.

const IMPORTANT_KEYWORDS = [
  "must", "always", "never", "required", "important", "critical",
  "do not", "don't", "forbidden", "prohibited", "restrict",
  "you are", "your role", "your goal", "your task",
  "workspace", "user", "tool", "format", "output",
];

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Score a sentence by keyword density (number of important keywords present).
 * Returns a value in [0, 1] where 1 is most important.
 */
function scoreSentence(sentence: string): number {
  const lower = sentence.toLowerCase();
  let hits = 0;
  for (const kw of IMPORTANT_KEYWORDS) {
    if (lower.includes(kw)) hits++;
  }
  // Normalize by total keyword count, cap at 1.0
  return Math.min(1.0, hits / IMPORTANT_KEYWORDS.length);
}

/**
 * Compresses a prompt to fit within targetTokens.
 * Splits on sentence boundaries, scores each sentence, removes the
 * lowest-scoring sentences until under budget.
 *
 * If the prompt already fits, it is returned unchanged.
 */
export function compressPrompt(prompt: string, targetTokens: number): string {
  if (estimateTokens(prompt) <= targetTokens) {
    return prompt;
  }

  // Split into sentences (rough: split on ". ", ".\n", "! ", "? ")
  const rawSentences = prompt.split(/(?<=[.!?])\s+/);
  if (rawSentences.length <= 1) {
    // Cannot split further — truncate by character budget
    return prompt.slice(0, targetTokens * 4);
  }

  // Score each sentence
  const scored = rawSentences.map((sentence, idx) => ({
    sentence,
    idx,
    score: scoreSentence(sentence),
  }));

  // Sort by score descending (lowest score first to remove)
  const byScore = [...scored].sort((a, b) => a.score - b.score);

  // Build a removal set; remove lowest-scored sentences until under budget
  const toRemove = new Set<number>();
  let currentTokens = estimateTokens(prompt);

  for (const { idx, sentence } of byScore) {
    if (currentTokens <= targetTokens) break;
    toRemove.add(idx);
    currentTokens -= estimateTokens(sentence);
  }

  // Reconstruct in original order, skipping removed sentences
  const kept = scored
    .filter(({ idx }) => !toRemove.has(idx))
    .map(({ sentence }) => sentence);

  return kept.join(" ");
}
