// ── Sub-Agent Output Contracts (Feature 10) ─────────────────────────
// Zod schemas defining what each sub-agent role must return. The swarm
// orchestrator validates outputs and can auto-retry on violations.

import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────

export interface OutputContract {
  roleId: string;
  schema: z.ZodTypeAny;
  description: string;
  strictMode?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  parsed?: unknown;
  errors?: string[];
}

// ── Default Contracts ────────────────────────────────────────────────

const ResearcherSchema = z.object({
  findings: z.array(z.string()).describe("Key findings from research"),
  sources: z.array(z.string()).describe("Sources cited"),
  confidence: z.number().min(0).max(1).describe("Confidence level 0-1"),
});

const AnalystSchema = z.object({
  analysis: z.string().describe("Analysis summary"),
  metrics: z.record(z.string(), z.number()).describe("Quantitative metrics"),
  confidence: z.number().min(0).max(1).describe("Confidence level 0-1"),
  methodology: z.string().optional().describe("Analysis methodology used"),
});

const WriterSchema = z.object({
  content: z.string().describe("Written content"),
  wordCount: z.number().int().positive().describe("Word count"),
  tone: z.string().optional().describe("Tone of the writing"),
});

const ValidatorSchema = z.object({
  validations: z.array(z.object({
    claim: z.string(),
    valid: z.boolean(),
    reason: z.string(),
  })).describe("Validation results per claim"),
  overallValid: z.boolean().describe("Whether all claims are valid"),
});

export const DEFAULT_OUTPUT_CONTRACTS: Record<string, OutputContract> = {
  researcher: {
    roleId: "researcher",
    schema: ResearcherSchema,
    description: "Structured research findings with sources and confidence",
  },
  analyst: {
    roleId: "analyst",
    schema: AnalystSchema,
    description: "Quantitative analysis with metrics and methodology",
  },
  writer: {
    roleId: "writer",
    schema: WriterSchema,
    description: "Written content with word count",
  },
  validator: {
    roleId: "validator",
    schema: ValidatorSchema,
    description: "Claim-by-claim validation report",
  },
};

// ── Contract Registry ────────────────────────────────────────────────

const contracts = new Map<string, OutputContract>(
  Object.entries(DEFAULT_OUTPUT_CONTRACTS),
);

export function registerOutputContract(contract: OutputContract): void {
  contracts.set(contract.roleId, contract);
}

export function getOutputContract(roleId: string): OutputContract | undefined {
  return contracts.get(roleId);
}

// ── Validation ───────────────────────────────────────────────────────

export function validateAgentOutput(
  roleId: string,
  content: string,
  contract?: OutputContract,
): ValidationResult {
  return parseAgentOutput(roleId, content, contract);
}

export function parseAgentOutput(
  roleId: string,
  content: string,
  contract?: OutputContract,
): ValidationResult {
  const c = contract ?? contracts.get(roleId);
  if (!c) return { valid: true }; // No contract = no validation

  const json = extractJsonPayload(content);
  if (json === null) {
    return {
      valid: false,
      errors: [
        `Expected JSON output matching the ${c.roleId} contract, but no valid JSON was found.`,
        "Return only a JSON object or wrap the JSON in a ```json fenced block.",
      ],
    };
  }

  const result = c.schema.safeParse(json);
  if (result.success) {
    return { valid: true, parsed: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
}

// ── JSON Extraction ──────────────────────────────────────────────────

function extractJsonPayload(content: string): unknown | null {
  // Try ```json ... ``` fenced block first.
  const fenced = content.match(/```json\s*\n?([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1]!.trim());
    if (parsed !== null) return parsed;
  }

  // Then try to recover the first balanced JSON object/array from mixed text.
  const balanced = extractFirstBalancedJson(content);
  if (balanced !== null) {
    const parsed = tryParseJson(balanced);
    if (parsed !== null) return parsed;
  }

  // Finally, try the trimmed content verbatim.
  return tryParseJson(content.trim());
}

function extractFirstBalancedJson(content: string): string | null {
  for (let i = 0; i < content.length; i++) {
    const start = content[i];
    if (start !== "{" && start !== "[") continue;

    const slice = sliceBalancedJson(content, i);
    if (slice !== null) return slice;
  }

  return null;
}

function sliceBalancedJson(content: string, startIndex: number): string | null {
  const opening = content[startIndex];
  if (opening !== "{" && opening !== "[") return null;

  const stack: string[] = [opening];
  let inString = false;
  let escape = false;

  for (let i = startIndex + 1; i < content.length; i++) {
    const ch = content[i]!;

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (!open) return null;

      const expectedClose = open === "{" ? "}" : "]";
      if (ch !== expectedClose) return null;

      if (stack.length === 0) {
        return content.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function tryParseJson(raw: string): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Prompt Formatting ────────────────────────────────────────────────

export function formatContractForPrompt(contract: OutputContract): string {
  const example = buildSchemaExample(contract.schema);
  const styleGuide = contract.strictMode
    ? "Return ONLY valid JSON. Do not add markdown or commentary."
    : "Return a JSON object. A fenced ```json block is preferred.";

  return `
## Required Output Format

Contract: ${contract.roleId}
${contract.description}

${styleGuide}

Example:
\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`
`;
}

export function buildContractRetryHint(
  contract: OutputContract,
  errors: string[] = [],
): string {
  const example = buildSchemaExample(contract.schema);
  const errorBlock = errors.length > 0
    ? `\nProblems detected:\n${errors.map((error) => `- ${error}`).join("\n")}\n`
    : "\n";

  return `\n## Output Contract Retry\n${errorBlock}Return a valid JSON object that matches the ${contract.roleId} contract exactly.\nUse this shape as a guide:\n\`\`\`json\n${JSON.stringify(example, null, 2)}\n\`\`\`\nReturn JSON only.`;
}

function buildSchemaExample(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodOptional) {
    return buildSchemaExample(schema.unwrap() as z.ZodTypeAny);
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const example: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      example[key] = buildSchemaExample(field);
    }
    return example;
  }

  if (schema instanceof z.ZodArray) {
    return [buildSchemaExample(schema.element as z.ZodTypeAny)];
  }

  if (schema instanceof z.ZodRecord) {
    return { key: "<value>" };
  }

  if (schema instanceof z.ZodString) return "<string>";
  if (schema instanceof z.ZodNumber) return 0;
  if (schema instanceof z.ZodBoolean) return true;

  if (schema instanceof z.ZodEnum) {
    return schema.options[0] ?? "<enum>";
  }

  if (schema instanceof z.ZodLiteral) {
    return schema.value;
  }

  return "<value>";
}
