import { z } from "zod";

// ── Zod → JSON Schema Converter ─────────────────────────────────────
// Zod v4 ships with a built-in JSON Schema converter. We post-process
// the output to make it more LLM-friendly:
//   1. Strip $schema — wastes tokens, LLMs don't need it
//   2. Remove defaulted fields from `required` — Zod fills them at
//      parse time, so the LLM shouldn't be forced to provide them
//   3. Drop keys unsupported by common LLM function-calling APIs
//      (additionalProperties, propertyNames, $defs, etc.)

const STRIP_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "propertyNames",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "contentMediaType",
  "contentEncoding",
]);

function cleanSchema(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);
  if (typeof obj !== "object") return obj;

  const input = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (STRIP_KEYS.has(key)) continue;

    // allOf / oneOf / anyOf — keep but recurse into children
    out[key] = cleanSchema(value);
  }

  // Remove defaulted fields from `required`
  if (
    Array.isArray(out["required"]) &&
    typeof out["properties"] === "object" &&
    out["properties"] !== null
  ) {
    const props = out["properties"] as Record<string, Record<string, unknown>>;
    out["required"] = (out["required"] as string[]).filter(
      (name) => !props[name] || props[name]["default"] === undefined,
    );
    if ((out["required"] as string[]).length === 0) {
      delete out["required"];
    }
  }

  return out;
}

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  return cleanSchema(raw) as Record<string, unknown>;
}
