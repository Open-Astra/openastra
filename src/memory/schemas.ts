// ── Structured Memory Schemas ──────────────────────────────────────────
// Per-category JSON Schema validation for memory writes.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-schemas");

export interface MemorySchema {
  id: string;
  workspaceId: string;
  category: string;
  schema: Record<string, unknown>;
  strict: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export async function upsertMemorySchema(
  workspaceId: string,
  category: string,
  schema: Record<string, unknown>,
  strict = false,
  createdBy?: string,
): Promise<MemorySchema> {
  const id = randomUUID();
  const { rows } = await getPool().query<MemorySchema>(
    `INSERT INTO memory_schemas (id, workspace_id, category, schema, strict, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (workspace_id, category) DO UPDATE
       SET schema = EXCLUDED.schema,
           strict = EXCLUDED.strict,
           updated_at = NOW()
     RETURNING id, workspace_id AS "workspaceId", category, schema, strict,
               created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, workspaceId, category, JSON.stringify(schema), strict, createdBy ?? null],
  );
  return rows[0]!;
}

export async function getMemorySchema(
  workspaceId: string,
  category: string,
): Promise<MemorySchema | null> {
  const { rows } = await getPool().query<MemorySchema>(
    `SELECT id, workspace_id AS "workspaceId", category, schema, strict,
            created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM memory_schemas WHERE workspace_id = $1 AND category = $2`,
    [workspaceId, category],
  );
  return rows[0] ?? null;
}

export async function listMemorySchemas(workspaceId: string): Promise<MemorySchema[]> {
  const { rows } = await getPool().query<MemorySchema>(
    `SELECT id, workspace_id AS "workspaceId", category, schema, strict,
            created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM memory_schemas WHERE workspace_id = $1 ORDER BY category ASC`,
    [workspaceId],
  );
  return rows;
}

export async function deleteMemorySchema(
  workspaceId: string,
  category: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM memory_schemas WHERE workspace_id = $1 AND category = $2`,
    [workspaceId, category],
  );
  return (rowCount ?? 0) > 0;
}

/** Basic JSON Schema validation: checks type, required fields, and property types. */
function validateJsonSchema(
  schema: Record<string, unknown>,
  content: unknown,
): string[] {
  const errors: string[] = [];

  const schemaType = schema["type"];
  if (schemaType === "object") {
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      errors.push(`/ must be an object`);
      return errors;
    }
    const obj = content as Record<string, unknown>;
    const required = Array.isArray(schema["required"]) ? schema["required"] as string[] : [];
    for (const field of required) {
      if (!(field in obj)) errors.push(`/${field} is required`);
    }
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in obj)) continue;
      const propType = propSchema["type"];
      if (propType && typeof obj[key] !== propType) {
        errors.push(`/${key} must be of type ${String(propType)}`);
      }
    }
  } else if (schemaType === "string" && typeof content !== "string") {
    errors.push(`/ must be a string`);
  } else if (schemaType === "number" && typeof content !== "number") {
    errors.push(`/ must be a number`);
  } else if (schemaType === "boolean" && typeof content !== "boolean") {
    errors.push(`/ must be a boolean`);
  } else if (schemaType === "array" && !Array.isArray(content)) {
    errors.push(`/ must be an array`);
  }

  return errors;
}

export async function validateMemoryContent(
  workspaceId: string,
  category: string,
  content: unknown,
): Promise<SchemaValidationResult> {
  const memSchema = await getMemorySchema(workspaceId, category);
  if (!memSchema) return { valid: true, errors: [] };

  const errors = validateJsonSchema(memSchema.schema, content);
  if (errors.length === 0) return { valid: true, errors: [] };

  if (!memSchema.strict) {
    logger.warn(`Memory schema soft-violation for ${category}: ${errors.join("; ")}`);
    return { valid: true, errors };
  }

  return { valid: false, errors };
}

logger.info("Memory schemas module loaded");
