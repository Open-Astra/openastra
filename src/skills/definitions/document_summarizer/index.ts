import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Document Summarizer Skill ───────────────────────────────────────
// Extractive summarization using sentence scoring.
// Scores sentences by keyword frequency, position, and length.
// No LLM dependency — pure algorithmic extraction.

const SummarizeParams = z.object({
  text: z.string().min(100).describe("Text to summarize (min 100 chars)"),
  sentences: z.number().int().min(1).max(20).default(5).describe("Number of sentences in summary"),
  format: z.enum(["paragraph", "bullets", "structured"]).default("paragraph"),
});

const KeyPointsParams = z.object({
  text: z.string().min(100).describe("Text to extract key points from"),
  maxPoints: z.number().int().min(1).max(10).default(5),
});

// Stop words to exclude from keyword scoring
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "must", "shall",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off", "up", "down",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either", "neither",
  "this", "that", "these", "those", "it", "its", "he", "she", "they", "them", "their",
  "we", "our", "you", "your", "i", "me", "my", "who", "which", "what", "where", "when",
  "how", "why", "all", "each", "every", "any", "few", "more", "most", "other", "some",
  "such", "no", "only", "own", "same", "than", "too", "very", "just", "also",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\n{2,}/g, ". ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function scoreSentences(sentences: string[], wordFreq: Map<string, number>): Array<{ sentence: string; score: number; index: number }> {
  return sentences.map((sentence, index) => {
    const words = tokenize(sentence);

    // Keyword frequency score
    let freqScore = 0;
    for (const word of words) {
      freqScore += wordFreq.get(word) ?? 0;
    }
    freqScore = words.length > 0 ? freqScore / words.length : 0;

    // Position score (first and last sentences are usually important)
    const positionScore = index === 0 ? 1.5 : index < 3 ? 1.2 : index >= sentences.length - 2 ? 1.1 : 1.0;

    // Length score (prefer medium-length sentences)
    const lengthScore = words.length >= 5 && words.length <= 30 ? 1.0 : 0.7;

    // Indicator words
    const lower = sentence.toLowerCase();
    const indicatorScore = /\b(important|significant|key|main|critical|essential|notable|result|conclusion|therefore|however|furthermore|moreover)\b/.test(lower) ? 1.3 : 1.0;

    return {
      sentence,
      score: freqScore * positionScore * lengthScore * indicatorScore,
      index,
    };
  });
}

const documentSummarizerSkill: SkillDefinition = {
  name: "document_summarizer",
  version: "1.0.0",

  manifest: {
    id: "document_summarizer",
    name: "Document Summarizer",
    description: "Extractive text summarization using sentence scoring. Extracts key sentences and points without LLM.",
    category: "analyze",
    tools: ["doc_summarize", "doc_key_points"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "doc_summarize",
      description: "Summarize a document by extracting the most important sentences.",
      parameters: SummarizeParams,

      async execute(params) {
        const sentences = splitSentences(params.text);
        if (sentences.length === 0) return { error: "Could not extract sentences from text." };

        // Build word frequency map
        const allWords = tokenize(params.text);
        const wordFreq = new Map<string, number>();
        for (const word of allWords) wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);

        // Score and rank
        const scored = scoreSentences(sentences, wordFreq);
        scored.sort((a, b) => b.score - a.score);

        const topN = scored.slice(0, params.sentences);
        // Restore original order for coherent reading
        topN.sort((a, b) => a.index - b.index);

        const summaryText = topN.map((s) => s.sentence);
        const compressionRatio = Math.round((summaryText.join(" ").length / params.text.length) * 100);

        let output: string;
        switch (params.format) {
          case "bullets":
            output = summaryText.map((s) => `• ${s}`).join("\n");
            break;
          case "structured":
            output = summaryText.map((s, i) => `${i + 1}. ${s}`).join("\n");
            break;
          default:
            output = summaryText.join(" ");
        }

        return {
          summary: output,
          sentenceCount: topN.length,
          originalSentences: sentences.length,
          compressionRatio: `${compressionRatio}%`,
          topKeywords: [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, count]) => ({ word, count })),
        };
      },
    });

    ctx.registerTool({
      name: "doc_key_points",
      description: "Extract key points from a document. Returns the most important statements.",
      parameters: KeyPointsParams,

      async execute(params) {
        const sentences = splitSentences(params.text);
        const allWords = tokenize(params.text);
        const wordFreq = new Map<string, number>();
        for (const word of allWords) wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);

        const scored = scoreSentences(sentences, wordFreq);
        scored.sort((a, b) => b.score - a.score);

        const points = scored.slice(0, params.maxPoints).map((s, i) => ({
          rank: i + 1,
          point: s.sentence,
          relevance: Math.round(s.score * 100) / 100,
        }));

        return {
          pointCount: points.length,
          points,
          wordCount: params.text.split(/\s+/).length,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "document_summarizer",
      instructions: "You can summarize text with `doc_summarize` (extractive summary in paragraph/bullet/structured format) and `doc_key_points` (ranked key statements). No LLM needed — algorithmic extraction.",
    };
  },
};

export default documentSummarizerSkill;
