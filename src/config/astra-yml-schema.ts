import { readFile } from "node:fs/promises";
import { z } from "zod";
// ── Astra.yml Schema Validation ────────────────────────────────────
// Validates the astra.yml configuration file at startup using Zod.
// Catches misconfigurations, typos, and invalid values before the
// gateway starts — fail fast with actionable error messages.
//
// Used by:
//   - Gateway startup (auto-validate on boot)
//   - `astra doctor` command (explicit validation check)
//   - `astra validate` command (standalone validation)

// ── Schemas ────────────────────────────────────────────────────────

const ProviderSchema = z.enum([
  "anthropic", "openai", "grok", "groq", "gemini",
  "ollama", "bedrock", "openrouter", "mistral",
]);

const ModelSchema = z.string().min(1, "Model ID cannot be empty");

const QuotaSchema = z.object({
  max_tokens_per_hour: z.number().int().positive().optional(),
  max_tokens_per_day: z.number().int().positive().optional(),
  max_tokens_per_month: z.number().int().positive().optional(),
  max_requests_per_minute: z.number().int().positive().optional(),
  max_cost_per_day_usd: z.number().positive().optional(),
  max_spawn_depth: z.number().int().min(0).max(10).optional(),
}).strict().optional();

const ApprovalPolicySchema = z.object({
  require_approval: z.array(z.string()).optional(),
  auto_approve: z.array(z.string()).optional(),
  timeout_minutes: z.number().int().positive().optional(),
}).strict().optional();

const SelfHealSchema = z.object({
  restart_on_failure: z.boolean().optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  compaction_threshold: z.number().int().positive().optional(),
}).strict().optional();

const ToolSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().optional(),
  system_prompt: z.string().optional(),
  provider: ProviderSchema.optional(),
  model: ModelSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(ToolSchema).optional(),
  skills: z.array(z.string()).optional(),
  can_delegate_to: z.array(z.string()).optional(),
  memory_enabled: z.boolean().optional(),
  streaming: z.boolean().optional(),
}).strict();

const DefaultsSchema = z.object({
  provider: ProviderSchema.optional(),
  model: ModelSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  streaming: z.boolean().optional(),
}).strict().optional();

const EmbeddingsSchema = z.object({
  provider: z.enum(["gemini", "local"]).optional(),
  model: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
}).strict().optional();

const AstraYmlSchema = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  defaults: DefaultsSchema,
  embeddings: EmbeddingsSchema,
  quotas: QuotaSchema,
  approval: ApprovalPolicySchema,
  self_heal: SelfHealSchema,
  agents: z.array(AgentSchema).min(1, "At least one agent must be defined"),
}).strict();

export type AstraYmlConfig = z.infer<typeof AstraYmlSchema>;

// ── Validation ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
  config?: AstraYmlConfig;
}

export interface ValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export async function validateAstraYml(filePath: string): Promise<ValidationResult> {
  const warnings: string[] = [];

  // Read and parse YAML
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: "file", message: `Cannot read ${filePath}: ${err}` }],
      warnings,
    };
  }

  // Simple YAML-to-JSON parser (handles the subset used by astra.yml)
  let parsed: unknown;
  try {
    parsed = parseSimpleYaml(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: "yaml", message: `YAML parse error: ${err}` }],
      warnings,
    };
  }

  // Validate against schema
  const result = AstraYmlSchema.safeParse(parsed);

  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    return { valid: false, errors, warnings };
  }

  const config = result.data;

  // Semantic checks
  const agentIds = new Set<string>();
  for (const agent of config.agents) {
    if (agentIds.has(agent.id)) {
      return {
        valid: false,
        errors: [{ path: `agents[${agent.id}]`, message: `Duplicate agent ID: "${agent.id}"` }],
        warnings,
      };
    }
    agentIds.add(agent.id);
  }

  // Check delegation targets reference valid agents
  for (const agent of config.agents) {
    if (agent.can_delegate_to) {
      for (const targetId of agent.can_delegate_to) {
        if (!agentIds.has(targetId)) {
          warnings.push(`Agent "${agent.id}" delegates to unknown agent "${targetId}"`);
        }
      }
    }
  }

  // Warn about agents with no tools or skills
  for (const agent of config.agents) {
    if (!agent.tools?.length && !agent.skills?.length) {
      warnings.push(`Agent "${agent.id}" has no tools or skills configured`);
    }
  }

  // Warn if no default provider
  if (!config.defaults?.provider) {
    warnings.push("No default provider set — each agent must specify its own provider");
  }

  return { valid: true, errors: [], warnings, config };
}

// ── Simple YAML Parser ─────────────────────────────────────────────
// Handles the subset of YAML used by astra.yml: objects, arrays, strings, numbers, booleans.

function parseSimpleYaml(raw: string): unknown {
  const lines = raw.split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1]!.length : 0;
}

function parseYamlLines(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const obj: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent && i > startLine) break;

    const keyMatch = trimmed.match(/^([^:]+):\s*(.*)/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1]!.trim();
    const valueStr = keyMatch[2]!.trim();

    if (valueStr === "" || valueStr.startsWith("#")) {
      // Check if next line is an array or nested object
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty < lines.length) {
        const nextTrimmed = lines[nextNonEmpty]!.trim();
        const nextIndent = getIndent(lines[nextNonEmpty]!);
        if (nextIndent > indent && nextTrimmed.startsWith("- ")) {
          const arr = parseYamlArray(lines, nextNonEmpty, nextIndent);
          obj[key] = arr.value;
          i = arr.nextLine;
          continue;
        } else if (nextIndent > indent) {
          const nested = parseYamlLines(lines, nextNonEmpty, nextIndent);
          obj[key] = nested.value;
          i = nested.nextLine;
          continue;
        }
      }
      obj[key] = null;
      i++;
    } else {
      obj[key] = parseYamlValue(valueStr);
      i++;
    }
  }

  return { value: obj, nextLine: i };
}

function parseYamlArray(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const arr: unknown[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;

    if (trimmed.startsWith("- ")) {
      const itemStr = trimmed.slice(2).trim();

      // Check if it's a key-value starting an object
      const kvMatch = itemStr.match(/^([^:]+):\s*(.*)/);
      if (kvMatch) {
        const itemObj: Record<string, unknown> = {};
        const firstKey = kvMatch[1]!.trim();
        const firstVal = kvMatch[2]!.trim();
        itemObj[firstKey] = firstVal === "" ? null : parseYamlValue(firstVal);

        // Read remaining keys at deeper indent
        const nextNonEmpty = findNextNonEmpty(lines, i + 1);
        if (nextNonEmpty < lines.length && getIndent(lines[nextNonEmpty]!) > indent) {
          const nested = parseYamlLines(lines, nextNonEmpty, getIndent(lines[nextNonEmpty]!));
          Object.assign(itemObj, nested.value);
          i = nested.nextLine;
        } else {
          i++;
        }
        arr.push(itemObj);
      } else {
        arr.push(parseYamlValue(itemStr));
        i++;
      }
    } else {
      break;
    }
  }

  return { value: arr, nextLine: i };
}

function findNextNonEmpty(lines: string[], startLine: number): number {
  let i = startLine;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return i;
    i++;
  }
  return i;
}

function parseYamlValue(str: string): unknown {
  if (str.startsWith("#")) return null;

  // Remove inline comments
  const commentIdx = str.indexOf(" #");
  const clean = commentIdx >= 0 ? str.slice(0, commentIdx).trim() : str;

  if (clean === "true") return true;
  if (clean === "false") return false;
  if (clean === "null" || clean === "~") return null;

  // Quoted strings
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }

  // Numbers
  const num = Number(clean);
  if (!isNaN(num) && clean !== "") return num;

  // Inline array [a, b, c]
  if (clean.startsWith("[") && clean.endsWith("]")) {
    return clean.slice(1, -1).split(",").map((s) => parseYamlValue(s.trim()));
  }

  return clean;
}

export { AstraYmlSchema };
