// ── Structured Output Enforcement ─────────────────────────────────────
// Validates agent responses against a per-agent JSON schema.
// Attempts LLM-based repair when output fails validation.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import type { InferenceClient } from "../inference/types.js";

const logger = createLogger("structured-output");

export interface OutputSchema {
  agentId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  jsonSchema: Record<string, unknown>;
  enabled: boolean;
  maxRepairAttempts: number;
}

export async function getOutputSchema(
  agentId: string,
  workspaceId: string,
): Promise<OutputSchema | null> {
  const { rows } = await getPool().query<OutputSchema>(
    `SELECT agent_id AS "agentId", workspace_id AS "workspaceId",
            name, description, json_schema AS "jsonSchema",
            enabled, max_repair_attempts AS "maxRepairAttempts"
     FROM structured_output_schemas
     WHERE agent_id = $1 AND workspace_id = $2 AND enabled = true`,
    [agentId, workspaceId],
  );
  return rows[0] ?? null;
}

export async function upsertOutputSchema(
  agentId: string,
  workspaceId: string,
  name: string,
  jsonSchema: Record<string, unknown>,
  maxRepairAttempts = 2,
  description?: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO structured_output_schemas
       (workspace_id, agent_id, name, description, json_schema, max_repair_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           json_schema = EXCLUDED.json_schema,
           max_repair_attempts = EXCLUDED.max_repair_attempts,
           updated_at = NOW()`,
    [workspaceId, agentId, name, description ?? null, JSON.stringify(jsonSchema), maxRepairAttempts],
  );
}

export async function deleteOutputSchema(agentId: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM structured_output_schemas WHERE agent_id = $1 AND workspace_id = $2`,
    [agentId, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Validate a parsed object against a JSON schema (structural, not full Draft-7). */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const type = schema["type"] as string | undefined;

  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    errors.push(`Expected object, got ${typeof value}`);
    return { valid: false, errors };
  }

  if (type === "array" && !Array.isArray(value)) {
    errors.push(`Expected array, got ${typeof value}`);
    return { valid: false, errors };
  }

  if (type === "object" && typeof value === "object" && value !== null) {
    const required = (schema["required"] as string[] | undefined) ?? [];
    const obj = value as Record<string, unknown>;
    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`Missing required field: ${key}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Attempt to repair invalid output using the inference client. */
export async function repairStructuredOutput(
  original: string,
  schema: Record<string, unknown>,
  client: InferenceClient,
  maxAttempts: number,
): Promise<{ repaired: string; attempts: number; success: boolean }> {
  let current = original;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    const repairPrompt = `The following response must conform to this JSON schema:\n${JSON.stringify(schema, null, 2)}\n\nCurrent response (invalid):\n${current}\n\nReturn ONLY valid JSON that matches the schema, no explanation.`;

    try {
      const response = await client.chat({
        messages: [{ role: "user", content: repairPrompt }],
        temperature: 0,
        maxTokens: 2048,
      });
      const candidate = ( response.content ?? "").trim();
      // Strip markdown code fences if present
      const json = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(json) as unknown;
      const { valid } = validateAgainstSchema(parsed, schema);
      if (valid) {
        return { repaired: json, attempts, success: true };
      }
      current = json;
    } catch (err) {
      logger.warn(`Repair attempt ${attempts} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { repaired: current, attempts, success: false };
}
