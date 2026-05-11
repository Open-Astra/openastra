import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Entity Extractor Skill ──────────────────────────────────────────
// Named Entity Recognition (NER): extract people, places, orgs,
// dates, amounts, emails, URLs from text. Rule-based, zero LLM dep.

const ExtractParams = z.object({
  text: z.string().describe("Text to extract entities from"),
  types: z.array(z.enum(["person", "organization", "location", "date", "money", "email", "url", "phone", "percentage"])).optional()
    .describe("Entity types to extract (default: all)"),
});

interface Entity {
  text: string;
  type: string;
  start: number;
  end: number;
}

const PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  { type: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: "url", pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g },
  { type: "phone", pattern: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { type: "money", pattern: /\$[\d,]+(?:\.\d{2})?(?:\s*(?:million|billion|thousand|[MBK]))?/gi },
  { type: "percentage", pattern: /\d+(?:\.\d+)?%/g },
  { type: "date", pattern: /(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)/gi },
];

// Title case words that are likely proper nouns (simplified NER)
function extractProperNouns(text: string): Entity[] {
  const entities: Entity[] = [];
  // Match sequences of capitalized words (not at sentence start)
  const matches = text.matchAll(/(?<=[.!?]\s+\w+\s+|,\s+|;\s+|:\s+|\band\s+|\bthe\s+|\bof\s+|\bfor\s+|\bwith\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g);

  for (const match of matches) {
    const text = match[1]!;
    entities.push({ text, type: "entity", start: match.index!, end: match.index! + text.length });
  }

  // Also match all-caps words (likely acronyms/orgs)
  const acronyms = text.matchAll(/\b[A-Z]{2,6}\b/g);
  for (const match of acronyms) {
    const common = new Set(["THE", "AND", "FOR", "BUT", "NOT", "YOU", "ALL", "CAN", "HAD", "HER", "WAS", "ONE", "OUR"]);
    if (!common.has(match[0]!)) {
      entities.push({ text: match[0]!, type: "organization", start: match.index!, end: match.index! + match[0]!.length });
    }
  }

  return entities;
}

// Classify proper nouns using context clues
function classifyEntity(text: string, context: string): string {
  const lower = context.toLowerCase();
  const before50 = lower.slice(Math.max(0, lower.indexOf(text.toLowerCase()) - 50), lower.indexOf(text.toLowerCase()));

  if (/\b(?:mr|mrs|ms|dr|prof|president|ceo|coach|player)\b/.test(before50)) return "person";
  if (/\b(?:inc|corp|ltd|llc|company|group|team|bank|university)\b/.test(text.toLowerCase())) return "organization";
  if (/\b(?:city|state|country|street|avenue|county|island|mountain|lake|river)\b/.test(before50)) return "location";
  if (/\b(?:in|at|from|near|to)\b/.test(before50) && text.length > 3) return "location";
  if (/\b(?:said|told|asked|announced|tweeted)\b/.test(before50)) return "person";

  return "entity";
}

const entityExtractorSkill: SkillDefinition = {
  name: "entity_extractor",
  version: "1.0.0",

  manifest: {
    id: "entity_extractor",
    name: "Entity Extractor",
    description: "Extract named entities (people, places, orgs, dates, amounts, emails, URLs) from text using rule-based NER.",
    category: "analyze",
    tools: ["entity_extract"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "entity_extract",
      description: "Extract named entities from text. Finds people, organizations, locations, dates, money, emails, URLs, phone numbers, and percentages.",
      parameters: ExtractParams,

      async execute(params) {
        const allowedTypes: Set<string> | null = params.types ? new Set(params.types) : null;
        const entities: Entity[] = [];

        // Pattern-based extraction
        for (const { type, pattern } of PATTERNS) {
          if (allowedTypes && !allowedTypes.has(type)) continue;
          const matches = params.text.matchAll(new RegExp(pattern.source, pattern.flags));
          for (const match of matches) {
            entities.push({ text: match[0]!, type, start: match.index!, end: match.index! + match[0]!.length });
          }
        }

        // Proper noun extraction (NER)
        if (!allowedTypes || allowedTypes.has("person") || allowedTypes.has("organization") || allowedTypes.has("location")) {
          const properNouns = extractProperNouns(params.text);
          for (const noun of properNouns) {
            const classified = classifyEntity(noun.text, params.text);
            if (!allowedTypes || allowedTypes.has(classified) || classified === "entity") {
              entities.push({ ...noun, type: classified });
            }
          }
        }

        // Deduplicate
        const seen = new Set<string>();
        const unique = entities.filter((e) => {
          const key = `${e.type}:${e.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Summary by type
        const byType: Record<string, string[]> = {};
        for (const e of unique) {
          if (!byType[e.type]) byType[e.type] = [];
          byType[e.type]!.push(e.text);
        }

        return { entityCount: unique.length, byType, entities: unique };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "entity_extractor",
      instructions: "You can extract named entities with `entity_extract`. Finds people, organizations, locations, dates, money, emails, URLs, phones, and percentages. Rule-based, no LLM required.",
    };
  },
};

export default entityExtractorSkill;
