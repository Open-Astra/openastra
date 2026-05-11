import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Code Formatter Skill ────────────────────────────────────────────
// Format and beautify code in multiple languages using built-in
// formatters (no external dependencies).

const FormatParams = z.object({
  code: z.string().describe("Code to format"),
  language: z.enum(["json", "javascript", "typescript", "html", "css", "sql", "xml", "markdown"]).describe("Programming language"),
  indentSize: z.number().int().min(1).max(8).default(2).describe("Spaces per indent level"),
});

const MinifyParams = z.object({
  code: z.string().describe("Code to minify"),
  language: z.enum(["json", "javascript", "css", "html"]).describe("Programming language"),
});

function formatJSON(code: string, indent: number): string {
  const parsed = JSON.parse(code);
  return JSON.stringify(parsed, null, indent);
}

function formatSQL(code: string, indent: number): string {
  const indentStr = " ".repeat(indent);
  const keywords = ["SELECT", "FROM", "WHERE", "AND", "OR", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
    "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT INTO", "VALUES",
    "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "UNION"];

  let result = code.trim();
  // Uppercase keywords
  for (const kw of keywords) {
    result = result.replace(new RegExp(`\\b${kw}\\b`, "gi"), kw);
  }

  // Add newlines before major clauses
  const majorClauses = ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "UNION"];
  for (const clause of majorClauses) {
    result = result.replace(new RegExp(`\\s+${clause}\\b`, "g"), `\n${clause}`);
  }

  // Indent sub-clauses
  result = result.replace(/\n(AND|OR)\b/g, `\n${indentStr}$1`);
  result = result.replace(/\n(ON)\b/g, `\n${indentStr}$1`);

  return result.trim();
}

function formatCSS(code: string, indent: number): string {
  const indentStr = " ".repeat(indent);
  let result = code
    .replace(/\s*\{\s*/g, " {\n" + indentStr)
    .replace(/\s*;\s*/g, ";\n" + indentStr)
    .replace(/\s*\}\s*/g, "\n}\n")
    .replace(new RegExp(`${indentStr}\n}`, "g"), "\n}");

  // Clean up extra whitespace
  result = result.replace(/\n\s*\n/g, "\n").trim();
  return result;
}

const codeFormatterSkill: SkillDefinition = {
  name: "code_formatter",
  version: "1.0.0",

  manifest: {
    id: "code_formatter",
    name: "Code Formatter",
    description: "Format and beautify code in JSON, JavaScript, TypeScript, HTML, CSS, SQL, and more.",
    category: "transform",
    tools: ["code_format", "code_minify"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "code_format",
      description: "Format/beautify code with proper indentation and styling.",
      parameters: FormatParams,

      async execute(params) {
        try {
          let formatted: string;

          switch (params.language) {
            case "json":
              formatted = formatJSON(params.code, params.indentSize);
              break;
            case "sql":
              formatted = formatSQL(params.code, params.indentSize);
              break;
            case "css":
              formatted = formatCSS(params.code, params.indentSize);
              break;
            case "javascript":
            case "typescript": {
              // Basic JS/TS formatting: fix indentation
              const lines = params.code.split("\n");
              let level = 0;
              const indent = " ".repeat(params.indentSize);
              formatted = lines.map((line) => {
                const trimmed = line.trim();
                if (trimmed.startsWith("}") || trimmed.startsWith("]") || trimmed.startsWith(")")) level = Math.max(0, level - 1);
                const result = indent.repeat(level) + trimmed;
                if (trimmed.endsWith("{") || trimmed.endsWith("[") || trimmed.endsWith("(")) level++;
                return result;
              }).join("\n");
              break;
            }
            case "html":
            case "xml": {
              const lines = params.code.replace(/>\s*</g, ">\n<").split("\n");
              let level = 0;
              const indent = " ".repeat(params.indentSize);
              formatted = lines.map((line) => {
                const trimmed = line.trim();
                if (trimmed.match(/^<\//)) level = Math.max(0, level - 1);
                const result = indent.repeat(level) + trimmed;
                if (trimmed.match(/^<[^/!?].*[^/]>$/) && !trimmed.match(/<.*\/>/)) level++;
                return result;
              }).join("\n");
              break;
            }
            case "markdown":
              // Clean up markdown: normalize headers, add blank lines
              formatted = params.code
                .replace(/^(#{1,6})\s*/gm, "$1 ")
                .replace(/(^#{1,6} .+$)/gm, "\n$1\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
              break;
            default:
              formatted = params.code;
          }

          return { language: params.language, original: params.code.length, formatted: formatted.length, code: formatted };
        } catch (err) {
          return { error: `Format failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    ctx.registerTool({
      name: "code_minify",
      description: "Minify code by removing whitespace and comments.",
      parameters: MinifyParams,

      async execute(params) {
        try {
          let minified: string;

          switch (params.language) {
            case "json":
              minified = JSON.stringify(JSON.parse(params.code));
              break;
            case "javascript":
              minified = params.code
                .replace(/\/\/.*$/gm, "")           // line comments
                .replace(/\/\*[\s\S]*?\*\//g, "")  // block comments
                .replace(/\s+/g, " ")
                .replace(/\s*([{}();,:])\s*/g, "$1")
                .trim();
              break;
            case "css":
              minified = params.code
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\s+/g, " ")
                .replace(/\s*([{}:;,])\s*/g, "$1")
                .replace(/;}/g, "}")
                .trim();
              break;
            case "html":
              minified = params.code
                .replace(/<!--[\s\S]*?-->/g, "")
                .replace(/\s+/g, " ")
                .replace(/>\s+</g, "><")
                .trim();
              break;
            default:
              minified = params.code.replace(/\s+/g, " ").trim();
          }

          const savings = Math.round((1 - minified.length / params.code.length) * 100);
          return { language: params.language, original: params.code.length, minified: minified.length, savings: `${savings}%`, code: minified };
        } catch (err) {
          return { error: `Minify failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "code_formatter",
      instructions: "You can format code with `code_format` (beautify with proper indentation) and `code_minify` (compress by removing whitespace). Supports JSON, JS, TS, HTML, CSS, SQL, XML, Markdown.",
    };
  },
};

export default codeFormatterSkill;
