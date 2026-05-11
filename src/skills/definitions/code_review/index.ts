import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Code Review Skill ────────────────────────────────────────────
// Analyzes code for common security, performance, and style issues
// using regex pattern matching. No external API required.

const CodeReviewParams = z.object({
  code: z.string().describe("Source code to review"),
  language: z
    .enum(["javascript", "typescript", "python", "go", "rust", "java", "generic"])
    .optional()
    .describe("Programming language (auto-detected if omitted)"),
  focus: z
    .enum(["security", "performance", "style", "all"])
    .default("all")
    .describe("Review focus area (default: all)"),
});

interface CodeIssue {
  line: number;
  severity: "critical" | "warning" | "info";
  category: "security" | "performance" | "style";
  message: string;
  suggestion: string;
}

interface PatternRule {
  pattern: RegExp;
  severity: "critical" | "warning" | "info";
  category: "security" | "performance" | "style";
  message: string;
  suggestion: string;
  languages?: string[];
}

const RULES: PatternRule[] = [
  // ── Security Rules ──
  {
    pattern: /\beval\s*\(/,
    severity: "critical",
    category: "security",
    message: "Use of eval() detected",
    suggestion: "Avoid eval() — use JSON.parse(), Function constructor with validation, or a safe expression parser.",
    languages: ["javascript", "typescript", "python", "generic"],
  },
  {
    pattern: /\.innerHTML\s*=/,
    severity: "critical",
    category: "security",
    message: "Direct innerHTML assignment detected (XSS risk)",
    suggestion: "Use textContent, createElement, or a sanitizer like DOMPurify.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /\bexec\s*\(\s*['"`].*\+/,
    severity: "critical",
    category: "security",
    message: "Possible command injection via string concatenation in exec()",
    suggestion: "Use parameterized commands or execFile() with argument arrays.",
    languages: ["javascript", "typescript", "python", "generic"],
  },
  {
    pattern: /\bos\.system\s*\(/,
    severity: "critical",
    category: "security",
    message: "os.system() usage detected (command injection risk)",
    suggestion: "Use subprocess.run() with a list of arguments instead.",
    languages: ["python", "generic"],
  },
  {
    pattern: /['"`]\s*\+\s*\w+\s*\+\s*['"`].*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b/i,
    severity: "critical",
    category: "security",
    message: "Possible SQL injection via string concatenation",
    suggestion: "Use parameterized queries or prepared statements.",
  },
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b.*['"`]\s*\+\s*\w+/i,
    severity: "critical",
    category: "security",
    message: "Possible SQL injection via string concatenation",
    suggestion: "Use parameterized queries or prepared statements.",
  },
  {
    pattern: /(?:password|secret|api_?key|token|credential)\s*[:=]\s*['"`][^'"` ]{3,}['"`]/i,
    severity: "critical",
    category: "security",
    message: "Hardcoded secret or credential detected",
    suggestion: "Move secrets to environment variables or a secrets manager.",
  },
  {
    pattern: /\bcrypto\.createHash\s*\(\s*['"]md5['"]\s*\)/,
    severity: "warning",
    category: "security",
    message: "MD5 hash usage detected (cryptographically weak)",
    suggestion: "Use SHA-256 or stronger hashing algorithms.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /\bMath\.random\s*\(/,
    severity: "warning",
    category: "security",
    message: "Math.random() is not cryptographically secure",
    suggestion: "Use crypto.getRandomValues() or crypto.randomBytes() for security-sensitive randomness.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /\bdangerouslySetInnerHTML\s*=/,
    severity: "warning",
    category: "security",
    message: "dangerouslySetInnerHTML usage (XSS risk if input is unsanitized)",
    suggestion: "Ensure content is sanitized before using dangerouslySetInnerHTML.",
    languages: ["javascript", "typescript", "generic"],
  },

  // ── Performance Rules ──
  {
    pattern: /for\s*\([^)]*\)\s*\{[^}]*(?:await\s+\w+\.(?:find|query|select|fetch|get))/,
    severity: "warning",
    category: "performance",
    message: "Possible N+1 query pattern (database call inside loop)",
    suggestion: "Batch queries outside the loop or use eager loading / joins.",
  },
  {
    pattern: /\.forEach\s*\(\s*async\b/,
    severity: "warning",
    category: "performance",
    message: "async callback in forEach (runs in parallel without awaiting)",
    suggestion: "Use a for...of loop with await, or Promise.all() with .map() for controlled concurrency.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /new\s+RegExp\s*\(/,
    severity: "info",
    category: "performance",
    message: "Dynamic RegExp construction inside potentially hot path",
    suggestion: "If the pattern is constant, use a RegExp literal and hoist it outside the function.",
  },
  {
    pattern: /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/,
    severity: "warning",
    category: "performance",
    message: "JSON.parse(JSON.stringify()) used for deep cloning",
    suggestion: "Use structuredClone() (Node 17+) for better performance and support for more types.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /Array\s*\(\s*\d{6,}\s*\)/,
    severity: "warning",
    category: "performance",
    message: "Very large array allocation detected",
    suggestion: "Consider using a streaming or chunked approach for large data sets.",
  },

  // ── Style Rules ──
  {
    pattern: /(?:^|\s)(?:let|const|var)\s+\w+\s*=\s*(?:[0-9]+(?:\.[0-9]+)?)\s*[;,]?\s*$/m,
    severity: "info",
    category: "style",
    message: "Magic number detected — consider using a named constant",
    suggestion: "Extract the number into a descriptively named constant for readability.",
  },
  {
    pattern: /\bconsole\.log\s*\(/,
    severity: "info",
    category: "style",
    message: "console.log() left in code",
    suggestion: "Use a proper logger or remove debug statements before committing.",
    languages: ["javascript", "typescript", "generic"],
  },
  {
    pattern: /\/\/\s*TODO\b/i,
    severity: "info",
    category: "style",
    message: "TODO comment found",
    suggestion: "Track TODOs in an issue tracker and resolve or remove before merging.",
  },
  {
    pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/,
    severity: "warning",
    category: "style",
    message: "Empty catch block — errors are silently swallowed",
    suggestion: "At minimum, log the error. Consider re-throwing or handling it properly.",
  },
  {
    pattern: /\bany\b/,
    severity: "info",
    category: "style",
    message: "Usage of 'any' type detected",
    suggestion: "Replace 'any' with a specific type or 'unknown' for better type safety.",
    languages: ["typescript"],
  },
];

function detectLanguage(code: string): string {
  if (/\bimport\s+type\b/.test(code) || /:\s*(?:string|number|boolean|void)\b/.test(code)) return "typescript";
  if (/\bfunction\b/.test(code) && /\bconst\b|\blet\b|\bvar\b/.test(code)) return "javascript";
  if (/\bdef\b/.test(code) && /\bimport\b/.test(code) && !/[{;}]/.test(code)) return "python";
  if (/\bfunc\b/.test(code) && /\bpackage\b/.test(code)) return "go";
  if (/\bfn\b/.test(code) && /\blet\s+mut\b/.test(code)) return "rust";
  if (/\bpublic\s+(?:class|static|void)\b/.test(code)) return "java";
  return "generic";
}

function measureNesting(code: string): { line: number; depth: number }[] {
  const deepNesting: { line: number; depth: number }[] = [];
  const lines = code.split("\n");
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth += opens - closes;
    if (depth > 4) {
      deepNesting.push({ line: i + 1, depth });
    }
  }

  return deepNesting;
}

function measureFunctionLength(code: string): { line: number; length: number }[] {
  const longFunctions: { line: number; length: number }[] = [];
  const funcStarts =
    /(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)|\b(?:async\s+)?(?:def|func|fn)\s+\w+)/g;
  const lines = code.split("\n");
  let match: RegExpExecArray | null;

  while ((match = funcStarts.exec(code)) !== null) {
    const startPos = match.index;
    const startLine = code.slice(0, startPos).split("\n").length;

    // Rough estimate: count lines until brace depth returns to 0
    let depth = 0;
    let started = false;
    let endLine = startLine;

    for (let i = startLine - 1; i < lines.length; i++) {
      const opens = (lines[i].match(/\{/g) ?? []).length;
      const closes = (lines[i].match(/\}/g) ?? []).length;
      if (opens > 0) started = true;
      depth += opens - closes;
      if (started && depth <= 0) {
        endLine = i + 1;
        break;
      }
      if (i === lines.length - 1) {
        endLine = i + 1;
      }
    }

    const length = endLine - startLine + 1;
    if (length > 40) {
      longFunctions.push({ line: startLine, length });
    }
  }

  return longFunctions;
}

const codeReviewSkill: SkillDefinition = {
  name: "code_review",
  version: "1.0.0",

  manifest: {
    id: "code_review",
    name: "Code Review",
    description:
      "Analyzes code for common security, performance, and style issues using pattern matching. No external API required.",
    category: "analyze",
    tools: ["code_review"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "code_review",
      description:
        "Review code for security vulnerabilities, performance issues, and style problems. Supports JavaScript, TypeScript, Python, Go, Rust, and Java.",
      parameters: CodeReviewParams,

      async execute(params) {
        const language = params.language ?? detectLanguage(params.code);
        const focus = params.focus;
        const lines = params.code.split("\n");
        const issues: CodeIssue[] = [];

        // Run pattern rules
        for (const rule of RULES) {
          if (focus !== "all" && rule.category !== focus) continue;
          if (rule.languages && !rule.languages.includes(language) && !rule.languages.includes("generic")) continue;

          for (let i = 0; i < lines.length; i++) {
            if (rule.pattern.test(lines[i])) {
              issues.push({
                line: i + 1,
                severity: rule.severity,
                category: rule.category,
                message: rule.message,
                suggestion: rule.suggestion,
              });
            }
          }
        }

        // Check deep nesting
        if (focus === "all" || focus === "style") {
          for (const nest of measureNesting(params.code)) {
            issues.push({
              line: nest.line,
              severity: "warning",
              category: "style",
              message: `Deep nesting detected (depth: ${nest.depth})`,
              suggestion: "Refactor using early returns, guard clauses, or extract helper functions.",
            });
          }
        }

        // Check long functions
        if (focus === "all" || focus === "style") {
          for (const func of measureFunctionLength(params.code)) {
            issues.push({
              line: func.line,
              severity: "info",
              category: "style",
              message: `Long function detected (${func.length} lines)`,
              suggestion: "Consider breaking this function into smaller, focused functions.",
            });
          }
        }

        // Deduplicate by line+message
        const seen = new Set<string>();
        const dedupedIssues = issues.filter((issue) => {
          const key = `${issue.line}:${issue.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Sort by severity then line number
        const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
        dedupedIssues.sort(
          (a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.line - b.line,
        );

        const summary = {
          critical: dedupedIssues.filter((i) => i.severity === "critical").length,
          warning: dedupedIssues.filter((i) => i.severity === "warning").length,
          info: dedupedIssues.filter((i) => i.severity === "info").length,
        };

        return {
          language,
          focus,
          totalLines: lines.length,
          issueCount: dedupedIssues.length,
          summary,
          issues: dedupedIssues,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "code_review",
      instructions:
        "You can analyze code for issues using the `code_review` tool. Provide source code and optionally specify the language and focus area (security, performance, style, or all).",
    };
  },
};

export default codeReviewSkill;
