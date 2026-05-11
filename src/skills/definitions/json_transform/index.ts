import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── JSON Transform Skill ──────────────────────────────────────────
// Transforms JSON data using simple jq-like expressions.
// Supports key access, array indexing, array mapping, and filtering.

function applyJqExpression(data: unknown, expression: string): unknown {
  const parts = expression.split("|").map((p) => p.trim());
  let current: unknown = data;

  for (const part of parts) {
    if (part === ".") {
      continue;
    }

    // Array index: .[0], .[1], etc.
    const indexMatch = part.match(/^\.\[(\d+)\]$/);
    if (indexMatch) {
      if (!Array.isArray(current)) {
        throw new Error(`Cannot index non-array with [${indexMatch[1]}]`);
      }
      current = current[parseInt(indexMatch[1], 10)];
      continue;
    }

    // Key access: .key or .key.subkey
    if (part.startsWith(".")) {
      const keys = part.slice(1).split(".");
      for (const key of keys) {
        if (current == null || typeof current !== "object") {
          throw new Error(`Cannot access key "${key}" on ${typeof current}`);
        }
        current = (current as Record<string, unknown>)[key];
      }
      continue;
    }

    // Array map: map(.field)
    const mapMatch = part.match(/^map\(\.(\w+)\)$/);
    if (mapMatch) {
      if (!Array.isArray(current)) {
        throw new Error("Cannot map over non-array");
      }
      current = current.map((item: unknown) => {
        if (item == null || typeof item !== "object") return undefined;
        return (item as Record<string, unknown>)[mapMatch[1]];
      });
      continue;
    }

    // Array select/filter: select(.field == "value") or select(.field > N)
    const selectMatch = part.match(/^select\(\.(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)\)$/);
    if (selectMatch) {
      if (!Array.isArray(current)) {
        throw new Error("Cannot select from non-array");
      }
      const [, field, op, rawVal] = selectMatch;
      const val = rawVal.startsWith('"') && rawVal.endsWith('"')
        ? rawVal.slice(1, -1)
        : Number(rawVal);

      current = current.filter((item: unknown) => {
        if (item == null || typeof item !== "object") return false;
        const fieldVal = (item as Record<string, unknown>)[field];
        switch (op) {
          case "==": return fieldVal === val;
          case "!=": return fieldVal !== val;
          case ">":  return (fieldVal as number) > (val as number);
          case "<":  return (fieldVal as number) < (val as number);
          case ">=": return (fieldVal as number) >= (val as number);
          case "<=": return (fieldVal as number) <= (val as number);
          default: return false;
        }
      });
      continue;
    }

    // length
    if (part === "length") {
      if (Array.isArray(current)) {
        current = current.length;
      } else if (typeof current === "string") {
        current = current.length;
      } else if (current != null && typeof current === "object") {
        current = Object.keys(current).length;
      } else {
        throw new Error(`Cannot get length of ${typeof current}`);
      }
      continue;
    }

    // keys
    if (part === "keys") {
      if (current != null && typeof current === "object" && !Array.isArray(current)) {
        current = Object.keys(current);
      } else {
        throw new Error("Cannot get keys of non-object");
      }
      continue;
    }

    throw new Error(`Unsupported jq expression part: "${part}"`);
  }

  return current;
}

const JsonTransformParams = z.object({
  input: z.string().describe("JSON string to transform"),
  jqExpression: z.string().describe("jq-like expression (e.g. '.data | map(.name)', '.items | select(.price > 10)')"),
});

const jsonTransformSkill: SkillDefinition = {
  name: "json_transform",
  version: "1.0.0",

  manifest: {
    id: "json_transform",
    name: "JSON Transform",
    description: "Transforms JSON data using jq-like expressions. Supports key access, array mapping, filtering, length, and keys.",
    category: "transform",
    tools: ["json_transform"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "json_transform",
      description: "Transform JSON data using a jq-like expression. Supports dot-notation key access, array indexing, map(.field), select(.field op value), length, and keys.",
      parameters: JsonTransformParams,

      async execute(params) {
        let data: unknown;
        try {
          data = JSON.parse(params.input);
        } catch {
          return { error: "Invalid JSON input." };
        }

        try {
          const result = applyJqExpression(data, params.jqExpression);
          return { result: JSON.stringify(result, null, 2) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Transform failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "json_transform",
      instructions: "You can transform JSON data using the `json_transform` tool with jq-like expressions.",
    };
  },
};

export default jsonTransformSkill;
