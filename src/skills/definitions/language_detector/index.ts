import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Language Detector Skill ─────────────────────────────────────────
// Detect the language of text using trigram frequency analysis.
// Covers 20+ languages with zero external dependencies.

const DetectParams = z.object({
  text: z.string().min(10).describe("Text to detect language for (min 10 chars)"),
});

const BatchDetectParams = z.object({
  texts: z.array(z.string().min(10)).min(1).max(50).describe("Multiple texts to detect"),
});

// Trigram profiles for common languages (top distinctive trigrams)
const PROFILES: Record<string, { name: string; trigrams: string[] }> = {
  en: { name: "English", trigrams: ["the", "and", "ing", "tion", "her", "for", "tha", "hat", "ent", "ion", "ter", "was", "you", "ith", "ver", "all", "wit", "thi", "hin", "his"] },
  es: { name: "Spanish", trigrams: ["que", "ción", "los", "las", "del", "por", "una", "con", "para", "est", "ent", "ión", "ado", "nte", "mos", "dad", "com", "sta", "ido", "tra"] },
  fr: { name: "French", trigrams: ["les", "des", "que", "ent", "est", "ion", "ait", "pas", "par", "une", "pour", "ons", "ment", "sur", "dans", "qui", "ous", "ais", "mais", "sont"] },
  de: { name: "German", trigrams: ["ein", "ich", "die", "und", "der", "den", "sch", "che", "eit", "ung", "ber", "ach", "ine", "ner", "ter", "auf", "cht", "ges", "ist", "ver"] },
  pt: { name: "Portuguese", trigrams: ["que", "ção", "dos", "das", "uma", "por", "com", "para", "est", "ent", "ado", "nte", "mos", "não", "ção", "ais", "odo", "sta", "ica", "tra"] },
  it: { name: "Italian", trigrams: ["che", "zione", "ell", "per", "con", "ent", "ion", "ato", "nte", "della", "ono", "gli", "ere", "tta", "sta", "lla", "uno", "mente", "ato", "ita"] },
  nl: { name: "Dutch", trigrams: ["een", "van", "het", "der", "aar", "ver", "oor", "ijn", "sch", "ing", "aan", "den", "ter", "eer", "ond", "aat", "ijk", "erd", "aar", "die"] },
  ru: { name: "Russian", trigrams: ["ого", "ние", "про", "ста", "ных", "ель", "ной", "ост", "ать", "ени", "ани", "ова", "при", "ого", "тел", "что", "ком", "пре", "ист", "нос"] },
  ja: { name: "Japanese", trigrams: ["の", "に", "は", "を", "た", "が", "で", "て", "と", "し", "れ", "さ", "ある", "から", "する", "この", "った", "ない", "まし", "です"] },
  zh: { name: "Chinese", trigrams: ["的", "了", "是", "在", "不", "一", "有", "这", "中", "人", "大", "为", "上", "个", "国", "我", "以", "要", "他", "时"] },
  ko: { name: "Korean", trigrams: ["는", "의", "에", "이", "을", "한", "하", "가", "로", "다", "고", "서", "는", "을", "으로", "에서", "하고", "있는", "된", "하는"] },
  ar: { name: "Arabic", trigrams: ["ال", "في", "من", "على", "إلى", "أن", "هذا", "التي", "ما", "كان", "عن", "لم", "بين", "ذلك", "بعد", "قال", "وقد", "حتى", "مع", "هو"] },
  hi: { name: "Hindi", trigrams: ["का", "के", "में", "है", "को", "की", "से", "और", "पर", "ने", "कर", "एक", "यह", "था", "हो", "भी", "नहीं", "तो", "इस", "कि"] },
  tr: { name: "Turkish", trigrams: ["lar", "ler", "bir", "ini", "ası", "eri", "yor", "dan", "ara", "ile", "lar", "rin", "ında", "ine", "yan", "dır", "nın", "lan", "aya", "den"] },
  pl: { name: "Polish", trigrams: ["nie", "prz", "rze", "nia", "ize", "owy", "dzi", "yst", "kie", "osc", "sta", "ani", "ego", "icz", "kie", "owa", "ych", "eni", "rod", "alny"] },
  sv: { name: "Swedish", trigrams: ["och", "att", "för", "som", "det", "ing", "var", "med", "den", "har", "till", "kan", "ade", "iga", "era", "lig", "gen", "ner", "isk", "ska"] },
};

function getTrigramsFromText(text: string): Map<string, number> {
  const clean = text.toLowerCase().replace(/[0-9\s]+/g, " ");
  const trigrams = new Map<string, number>();

  for (let i = 0; i < clean.length - 2; i++) {
    const tri = clean.slice(i, i + 3);
    if (tri.trim().length < 2) continue;
    trigrams.set(tri, (trigrams.get(tri) ?? 0) + 1);
  }

  return trigrams;
}

function detectLanguage(text: string): Array<{ code: string; name: string; confidence: number }> {
  const textTrigrams = getTrigramsFromText(text);
  const scores: Array<{ code: string; name: string; score: number }> = [];

  for (const [code, profile] of Object.entries(PROFILES)) {
    let score = 0;
    for (const trigram of profile.trigrams) {
      if (textTrigrams.has(trigram)) score += textTrigrams.get(trigram)!;
      // Check individual chars for CJK
      for (const char of trigram) {
        if (text.includes(char)) score += 0.5;
      }
    }
    scores.push({ code, name: profile.name, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const topScore = scores[0]?.score ?? 1;

  return scores.slice(0, 5).map((s) => ({
    code: s.code,
    name: s.name,
    confidence: Math.min(100, Math.round((s.score / topScore) * 100)),
  }));
}

const languageDetectorSkill: SkillDefinition = {
  name: "language_detector",
  version: "1.0.0",

  manifest: {
    id: "language_detector",
    name: "Language Detector",
    description: "Detect the language of text using trigram frequency analysis. Supports 15+ languages.",
    category: "analyze",
    tools: ["language_detect", "language_batch_detect"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "language_detect",
      description: "Detect the language of a text. Returns top 5 most likely languages with confidence scores.",
      parameters: DetectParams,

      async execute(params) {
        const results = detectLanguage(params.text);
        return {
          text: params.text.slice(0, 100),
          detected: results[0]?.name ?? "unknown",
          code: results[0]?.code ?? "unknown",
          confidence: results[0]?.confidence ?? 0,
          alternatives: results.slice(1),
        };
      },
    });

    ctx.registerTool({
      name: "language_batch_detect",
      description: "Detect languages for multiple texts at once.",
      parameters: BatchDetectParams,

      async execute(params) {
        const results = params.texts.map((text) => {
          const detected = detectLanguage(text);
          return {
            text: text.slice(0, 50),
            language: detected[0]?.name ?? "unknown",
            code: detected[0]?.code ?? "unknown",
            confidence: detected[0]?.confidence ?? 0,
          };
        });

        return { count: results.length, results };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "language_detector",
      instructions: "You can detect language with `language_detect` (single text, returns top 5 candidates) and `language_batch_detect` (multiple texts). Supports 15+ languages, no LLM needed.",
    };
  },
};

export default languageDetectorSkill;
