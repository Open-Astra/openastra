import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Regex Builder Skill ─────────────────────────────────────────────
// Build, test, and explain regular expressions.

const TestRegexParams = z.object({
  pattern: z.string().describe("Regular expression pattern"),
  flags: z.string().default("g").describe("Regex flags (g, i, m, s, u)"),
  testString: z.string().describe("String to test against"),
});

const ExplainRegexParams = z.object({
  pattern: z.string().describe("Regular expression to explain"),
});

const BuildRegexParams = z.object({
  description: z.string().describe("Natural language description of what to match (e.g. 'email addresses', 'phone numbers', 'URLs')"),
});

const COMMON_PATTERNS: Record<string, { pattern: string; description: string }> = {
  email: { pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", description: "Email addresses" },
  url: { pattern: "https?://[^\\s/$.?#].[^\\s]*", description: "HTTP/HTTPS URLs" },
  phone: { pattern: "(?:\\+?1[-.]?)?(?:\\(\\d{3}\\)|\\d{3})[-.]?\\d{3}[-.]?\\d{4}", description: "US phone numbers" },
  ipv4: { pattern: "(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)", description: "IPv4 addresses" },
  date_iso: { pattern: "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])", description: "ISO dates (YYYY-MM-DD)" },
  date_us: { pattern: "(?:0[1-9]|1[0-2])/(?:0[1-9]|[12]\\d|3[01])/\\d{4}", description: "US dates (MM/DD/YYYY)" },
  hex_color: { pattern: "#(?:[0-9a-fA-F]{3}){1,2}", description: "Hex color codes" },
  zip_code: { pattern: "\\d{5}(?:-\\d{4})?", description: "US ZIP codes" },
  ssn: { pattern: "\\d{3}-\\d{2}-\\d{4}", description: "Social Security Numbers" },
  credit_card: { pattern: "(?:4\\d{3}|5[1-5]\\d{2}|6011|3[47]\\d{2})[-\\s]?\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}", description: "Credit card numbers" },
  uuid: { pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", description: "UUIDs" },
  json_key: { pattern: '"([^"]+)"\\s*:', description: "JSON keys" },
  number: { pattern: "-?\\d+(?:\\.\\d+)?", description: "Numbers (integer or decimal)" },
  word: { pattern: "\\b[a-zA-Z]+\\b", description: "Words (letters only)" },
};

const TOKEN_DESCRIPTIONS: Record<string, string> = {
  ".": "any character",
  "\\d": "digit (0-9)",
  "\\D": "non-digit",
  "\\w": "word character (letter, digit, underscore)",
  "\\W": "non-word character",
  "\\s": "whitespace",
  "\\S": "non-whitespace",
  "\\b": "word boundary",
  "^": "start of string",
  "$": "end of string",
  "*": "zero or more",
  "+": "one or more",
  "?": "optional (zero or one)",
  "|": "OR",
};

const regexBuilderSkill: SkillDefinition = {
  name: "regex_builder",
  version: "1.0.0",

  manifest: {
    id: "regex_builder",
    name: "Regex Builder",
    description: "Build, test, and explain regular expressions. Includes common pattern library.",
    category: "transform",
    tools: ["regex_test", "regex_explain", "regex_build"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "regex_test",
      description: "Test a regex pattern against a string. Returns all matches with positions.",
      parameters: TestRegexParams,

      async execute(params) {
        try {
          const regex = new RegExp(params.pattern, params.flags);
          const matches: Array<{ match: string; index: number; groups?: Record<string, string> }> = [];
          let m;

          if (params.flags.includes("g")) {
            while ((m = regex.exec(params.testString)) !== null) {
              matches.push({ match: m[0], index: m.index, groups: m.groups });
              if (!m[0]) break; // prevent infinite loop on zero-length matches
            }
          } else {
            m = regex.exec(params.testString);
            if (m) matches.push({ match: m[0], index: m.index, groups: m.groups });
          }

          return { pattern: params.pattern, flags: params.flags, isMatch: matches.length > 0, matchCount: matches.length, matches: matches.slice(0, 50) };
        } catch (err) {
          return { error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    ctx.registerTool({
      name: "regex_explain",
      description: "Explain what a regex pattern does in plain English.",
      parameters: ExplainRegexParams,

      async execute(params) {
        const tokens: string[] = [];
        let i = 0;
        const p = params.pattern;

        while (i < p.length) {
          if (p[i] === "\\" && i + 1 < p.length) {
            const escape = p.slice(i, i + 2);
            tokens.push(TOKEN_DESCRIPTIONS[escape] ?? `literal '${p[i + 1]}'`);
            i += 2;
          } else if (p[i] === "[") {
            const end = p.indexOf("]", i);
            const charClass = p.slice(i, end + 1);
            tokens.push(`character class ${charClass}`);
            i = end + 1;
          } else if (p[i] === "(") {
            if (p.slice(i, i + 3) === "(?:") {
              tokens.push("non-capturing group:");
              i += 3;
            } else if (p.slice(i, i + 4).match(/\(\?<[a-zA-Z]/)) {
              const nameEnd = p.indexOf(">", i);
              tokens.push(`named group '${p.slice(i + 3, nameEnd)}':`);
              i = nameEnd + 1;
            } else {
              tokens.push("capturing group:");
              i += 1;
            }
          } else if (p[i] === ")") {
            tokens.push("end group");
            i += 1;
          } else if (p[i] === "{") {
            const end = p.indexOf("}", i);
            const quantifier = p.slice(i, end + 1);
            tokens.push(`repeat ${quantifier}`);
            i = end + 1;
          } else if (TOKEN_DESCRIPTIONS[p[i]!]) {
            tokens.push(TOKEN_DESCRIPTIONS[p[i]!]!);
            i += 1;
          } else {
            tokens.push(`literal '${p[i]}'`);
            i += 1;
          }
        }

        // Check if it matches a known pattern
        let knownPattern: string | null = null;
        for (const [name, def] of Object.entries(COMMON_PATTERNS)) {
          if (params.pattern === def.pattern) { knownPattern = `${name}: ${def.description}`; break; }
        }

        return { pattern: params.pattern, tokens, knownPattern, summary: tokens.join(" → ") };
      },
    });

    ctx.registerTool({
      name: "regex_build",
      description: "Get a regex pattern from a natural language description. Uses a library of common patterns.",
      parameters: BuildRegexParams,

      async execute(params) {
        const desc = params.description.toLowerCase();
        const matches: Array<{ name: string; pattern: string; description: string }> = [];

        for (const [name, def] of Object.entries(COMMON_PATTERNS)) {
          if (desc.includes(name) || desc.includes(def.description.toLowerCase()) || name.includes(desc.replace(/s$/, ""))) {
            matches.push({ name, ...def });
          }
        }

        if (matches.length === 0) {
          return {
            suggestion: "No exact match found. Available patterns: " + Object.keys(COMMON_PATTERNS).join(", "),
            tip: "Try describing your pattern using keywords like: email, url, phone, date, ip, uuid, number, etc.",
          };
        }

        return { query: params.description, results: matches };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "regex_builder",
      instructions: "You can work with regex using `regex_test` (test pattern against text), `regex_explain` (explain pattern in English), and `regex_build` (get pattern from description).",
    };
  },
};

export default regexBuilderSkill;
