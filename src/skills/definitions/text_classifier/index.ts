import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Text Classifier Skill ───────────────────────────────────────────
// Classify text into custom categories using keyword matching
// and TF-IDF-like scoring. No LLM dependency.

const ClassifyParams = z.object({
  text: z.string().describe("Text to classify"),
  categories: z.array(z.object({
    name: z.string().describe("Category name"),
    keywords: z.array(z.string()).describe("Keywords/phrases that indicate this category"),
    weight: z.number().default(1).describe("Category weight multiplier"),
  })).min(2).max(20).describe("Category definitions with keywords"),
});

const AutoClassifyParams = z.object({
  text: z.string().describe("Text to auto-classify"),
  domain: z.enum(["general", "support", "news", "product", "email"]).default("general").describe("Classification domain"),
});

// Built-in category sets for auto-classification
const DOMAIN_CATEGORIES: Record<string, Array<{ name: string; keywords: string[] }>> = {
  general: [
    { name: "question", keywords: ["what", "how", "why", "when", "where", "who", "which", "can", "could", "would", "?"] },
    { name: "request", keywords: ["please", "need", "want", "help", "can you", "could you", "would you", "do this"] },
    { name: "feedback", keywords: ["good", "bad", "great", "terrible", "love", "hate", "improve", "suggestion", "opinion"] },
    { name: "information", keywords: ["fyi", "update", "note", "notice", "announce", "inform", "just so you know"] },
    { name: "greeting", keywords: ["hello", "hi", "hey", "good morning", "good evening", "thanks", "thank you"] },
  ],
  support: [
    { name: "bug_report", keywords: ["bug", "error", "broken", "crash", "not working", "issue", "problem", "fail"] },
    { name: "feature_request", keywords: ["feature", "add", "would be nice", "suggestion", "wish", "request", "implement"] },
    { name: "billing", keywords: ["charge", "payment", "invoice", "refund", "subscription", "cancel", "billing", "price"] },
    { name: "account", keywords: ["login", "password", "account", "sign up", "register", "profile", "settings"] },
    { name: "general_inquiry", keywords: ["question", "how to", "help", "info", "information", "explain"] },
  ],
  news: [
    { name: "politics", keywords: ["president", "congress", "senate", "election", "vote", "government", "policy", "law"] },
    { name: "technology", keywords: ["AI", "tech", "software", "startup", "app", "digital", "data", "computer", "internet"] },
    { name: "business", keywords: ["market", "stock", "company", "CEO", "revenue", "profit", "merger", "IPO"] },
    { name: "sports", keywords: ["game", "team", "player", "score", "win", "championship", "league", "match"] },
    { name: "science", keywords: ["research", "study", "discover", "scientist", "experiment", "climate", "space"] },
  ],
  product: [
    { name: "positive_review", keywords: ["love", "great", "excellent", "amazing", "recommend", "best", "perfect", "5 stars"] },
    { name: "negative_review", keywords: ["terrible", "awful", "worst", "broken", "waste", "disappointed", "1 star", "refund"] },
    { name: "comparison", keywords: ["vs", "versus", "compared to", "better than", "worse than", "alternative"] },
    { name: "purchase_intent", keywords: ["buy", "purchase", "order", "price", "cost", "deal", "discount", "sale"] },
  ],
  email: [
    { name: "action_required", keywords: ["please", "need", "urgent", "ASAP", "deadline", "by tomorrow", "action required"] },
    { name: "meeting", keywords: ["meeting", "call", "schedule", "calendar", "invite", "attend", "zoom", "conference"] },
    { name: "follow_up", keywords: ["follow up", "checking in", "any update", "reminder", "still waiting", "status"] },
    { name: "informational", keywords: ["fyi", "update", "announcement", "newsletter", "report", "summary"] },
  ],
};

function scoreCategory(text: string, keywords: string[], weight: number): number {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  let score = 0;

  for (const keyword of keywords) {
    const kw = keyword.toLowerCase();
    if (kw.includes(" ")) {
      // Multi-word phrase
      if (lower.includes(kw)) score += 2 * weight;
    } else {
      // Single word
      const count = words.filter((w) => w === kw || w.startsWith(kw)).length;
      score += count * weight;
    }
  }

  return score;
}

const textClassifierSkill: SkillDefinition = {
  name: "text_classifier",
  version: "1.0.0",

  manifest: {
    id: "text_classifier",
    name: "Text Classifier",
    description: "Classify text into custom or predefined categories using keyword matching. Supports custom and auto-classification.",
    category: "analyze",
    tools: ["text_classify", "text_auto_classify"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "text_classify",
      description: "Classify text into custom categories defined by keywords.",
      parameters: ClassifyParams,

      async execute(params) {
        const scores = params.categories.map((cat) => ({
          category: cat.name,
          score: scoreCategory(params.text, cat.keywords, cat.weight),
          keywords: cat.keywords.filter((kw) => params.text.toLowerCase().includes(kw.toLowerCase())),
        }));

        scores.sort((a, b) => b.score - a.score);
        const totalScore = scores.reduce((sum, s) => sum + s.score, 0);

        return {
          text: params.text.slice(0, 100),
          predicted: scores[0]?.category ?? "unknown",
          confidence: totalScore > 0 ? Math.round((scores[0]!.score / totalScore) * 100) : 0,
          scores: scores.map((s) => ({
            ...s,
            percentage: totalScore > 0 ? Math.round((s.score / totalScore) * 100) : 0,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "text_auto_classify",
      description: "Auto-classify text using built-in category sets for common domains (general, support, news, product, email).",
      parameters: AutoClassifyParams,

      async execute(params) {
        const categories = DOMAIN_CATEGORIES[params.domain] ?? DOMAIN_CATEGORIES.general!;

        const scores = categories.map((cat) => ({
          category: cat.name,
          score: scoreCategory(params.text, cat.keywords, 1),
          matchedKeywords: cat.keywords.filter((kw) => params.text.toLowerCase().includes(kw.toLowerCase())),
        }));

        scores.sort((a, b) => b.score - a.score);
        const totalScore = scores.reduce((sum, s) => sum + s.score, 0);

        return {
          domain: params.domain,
          text: params.text.slice(0, 100),
          predicted: scores[0]?.category ?? "unknown",
          confidence: totalScore > 0 ? Math.round((scores[0]!.score / totalScore) * 100) : 0,
          scores,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "text_classifier",
      instructions: "You can classify text with `text_classify` (custom categories with keywords) and `text_auto_classify` (built-in domains: general, support, news, product, email). No LLM required.",
    };
  },
};

export default textClassifierSkill;
