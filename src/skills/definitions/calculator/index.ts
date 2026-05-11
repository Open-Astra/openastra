import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Calculator Skill ──────────────────────────────────────────────
// Evaluates safe math expressions using a whitelist of operations.
// No eval — uses Function constructor with strict token validation.

const SAFE_TOKENS = /^[\d\s+\-*/().,%^]+$/;
const SAFE_FUNCTIONS = new Set([
  "Math.abs",
  "Math.ceil",
  "Math.floor",
  "Math.round",
  "Math.sqrt",
  "Math.pow",
  "Math.min",
  "Math.max",
  "Math.log",
  "Math.log2",
  "Math.log10",
  "Math.sin",
  "Math.cos",
  "Math.tan",
  "Math.PI",
  "Math.E",
]);

function isSafeExpression(expr: string): boolean {
  // Strip known safe math functions to validate remaining tokens
  let stripped = expr;
  for (const fn of SAFE_FUNCTIONS) {
    stripped = stripped.replaceAll(fn, "");
  }
  return SAFE_TOKENS.test(stripped);
}

const CalculatorParams = z.object({
  expression: z.string().describe("Math expression to evaluate (e.g. '2 + 3 * 4', 'Math.sqrt(16)')"),
});

const calculatorSkill: SkillDefinition = {
  name: "calculator",
  version: "1.0.0",

  manifest: {
    id: "calculator",
    name: "Calculator",
    description: "Evaluates safe mathematical expressions with support for common Math functions.",
    category: "execute",
    tools: ["calculator"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "calculator",
      description: "Evaluate a mathematical expression. Supports basic arithmetic (+, -, *, /, %, ^) and Math functions (sqrt, pow, abs, ceil, floor, round, min, max, log, sin, cos, tan, PI, E).",
      parameters: CalculatorParams,

      async execute(params) {
        const expr = params.expression.trim();

        if (!isSafeExpression(expr)) {
          return { error: "Expression contains disallowed characters or functions." };
        }

        try {
          // Replace ^ with ** for exponentiation
          const normalized = expr.replace(/\^/g, "**");
          const fn = new Function(`"use strict"; return (${normalized});`);
          const result: unknown = fn();

          if (typeof result !== "number" || !isFinite(result)) {
            return { error: "Expression did not produce a finite number.", raw: String(result) };
          }

          return { expression: expr, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Evaluation failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "calculator",
      instructions: "You can evaluate math expressions using the `calculator` tool. It supports basic arithmetic and common Math functions.",
    };
  },
};

export default calculatorSkill;
