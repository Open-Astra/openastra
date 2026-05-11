import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Sentiment Analysis Skill ────────────────────────────────────────
// Classify text sentiment using keyword-based analysis with
// intensity scoring. Zero LLM dependency — pure algorithmic.

const AnalyzeParams = z.object({
  text: z.string().describe("Text to analyze sentiment for"),
});

const BatchParams = z.object({
  texts: z.array(z.string()).min(1).max(50).describe("Multiple texts to analyze"),
});

// Sentiment lexicon (AFINN-inspired, simplified)
const POSITIVE: Record<string, number> = {
  good: 3, great: 4, excellent: 5, amazing: 5, wonderful: 5, fantastic: 5, love: 4,
  happy: 3, joy: 4, excited: 4, awesome: 4, beautiful: 4, perfect: 5, best: 4,
  brilliant: 4, outstanding: 5, superb: 5, nice: 2, fine: 2, pleased: 3, glad: 3,
  win: 3, won: 3, winning: 3, success: 4, profit: 3, gain: 2, improve: 2, better: 2,
  like: 2, enjoy: 3, fun: 3, positive: 2, right: 1, agree: 2, impressive: 3,
  strong: 2, confident: 3, bullish: 3, up: 1, high: 1, growth: 2, surge: 3,
};

const NEGATIVE: Record<string, number> = {
  bad: -3, terrible: -5, horrible: -5, awful: -5, worst: -5, hate: -4, angry: -4,
  sad: -3, disappointed: -3, frustrated: -4, annoyed: -3, upset: -3, poor: -3,
  fail: -3, failed: -3, failure: -4, loss: -3, lost: -3, lose: -3, losing: -3,
  wrong: -2, mistake: -3, error: -3, problem: -3, issue: -2, broken: -3,
  ugly: -3, weak: -2, bearish: -3, down: -1, low: -1, decline: -3, crash: -4,
  risk: -2, danger: -3, fear: -3, worry: -2, concern: -2, negative: -2, hurt: -3,
  miss: -2, missed: -2, bust: -3, busted: -4,
};

const INTENSIFIERS = new Set(["very", "extremely", "incredibly", "really", "absolutely", "totally", "so", "super"]);
const NEGATORS = new Set(["not", "no", "never", "neither", "nor", "barely", "hardly", "without", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't"]);

function analyzeSentiment(text: string): { score: number; magnitude: number; label: string; words: Array<{ word: string; score: number }> } {
  const words = text.toLowerCase().replace(/[^\w\s'-]/g, "").split(/\s+/);
  let totalScore = 0;
  let totalMagnitude = 0;
  const scoredWords: Array<{ word: string; score: number }> = [];
  let negate = false;
  let intensify = false;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;

    if (NEGATORS.has(word)) { negate = true; continue; }
    if (INTENSIFIERS.has(word)) { intensify = true; continue; }

    let score = POSITIVE[word] ?? NEGATIVE[word] ?? 0;
    if (score !== 0) {
      if (negate) score = -score * 0.75;
      if (intensify) score *= 1.5;
      totalScore += score;
      totalMagnitude += Math.abs(score);
      scoredWords.push({ word, score: Math.round(score * 100) / 100 });
    }

    negate = false;
    intensify = false;
  }

  // Normalize score to -1 to 1 range
  const maxPossible = Math.max(words.length * 0.5, 1);
  const normalized = Math.max(-1, Math.min(1, totalScore / maxPossible));

  let label: string;
  if (normalized >= 0.3) label = "positive";
  else if (normalized >= 0.1) label = "slightly positive";
  else if (normalized <= -0.3) label = "negative";
  else if (normalized <= -0.1) label = "slightly negative";
  else label = "neutral";

  return {
    score: Math.round(normalized * 1000) / 1000,
    magnitude: Math.round(totalMagnitude * 100) / 100,
    label,
    words: scoredWords,
  };
}

const sentimentAnalysisSkill: SkillDefinition = {
  name: "sentiment_analysis",
  version: "1.0.0",

  manifest: {
    id: "sentiment_analysis",
    name: "Sentiment Analysis",
    description: "Analyze text sentiment (positive/negative/neutral) with intensity scoring and word-level breakdown.",
    category: "analyze",
    tools: ["sentiment_analyze", "sentiment_batch"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "sentiment_analyze",
      description: "Analyze sentiment of a single text. Returns score (-1 to 1), label, and word-level breakdown.",
      parameters: AnalyzeParams,

      async execute(params) {
        return analyzeSentiment(params.text);
      },
    });

    ctx.registerTool({
      name: "sentiment_batch",
      description: "Analyze sentiment for multiple texts at once.",
      parameters: BatchParams,

      async execute(params) {
        const results = params.texts.map((text) => ({
          text: text.slice(0, 100),
          ...analyzeSentiment(text),
        }));

        const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
        return {
          count: results.length,
          averageScore: Math.round(avgScore * 1000) / 1000,
          averageLabel: avgScore >= 0.1 ? "positive" : avgScore <= -0.1 ? "negative" : "neutral",
          results,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "sentiment_analysis",
      instructions: "You can analyze sentiment with `sentiment_analyze` (single text) and `sentiment_batch` (multiple texts). Returns score (-1 to 1), label, and word-level breakdown. No LLM required.",
    };
  },
};

export default sentimentAnalysisSkill;
