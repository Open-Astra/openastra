import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

// ── Prompt Template Library ───────────────────────────────────────────
// Manages reusable prompt templates with Handlebars-style {{variable}}
// interpolation. Templates are workspace-scoped and track usage counts.

export interface PromptTemplate {
  id: string;
  workspace_id: string;
  name: string;
  category: string;
  template: string;
  variables: string[];
  usage_count: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listTemplates(
  workspaceId: string,
  category: string | undefined,
  pool: Pool,
): Promise<PromptTemplate[]> {
  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (category !== undefined) {
    conditions.push(`category = $${idx++}`);
    values.push(category);
  }

  const where = conditions.join(" AND ");
  const result = await pool.query<PromptTemplate>(
    `SELECT id, workspace_id, name, category, template, variables, usage_count,
            created_by, created_at, updated_at
     FROM prompt_templates
     WHERE ${where}
     ORDER BY usage_count DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

export async function getTemplate(
  id: string,
  workspaceId: string,
  pool: Pool,
): Promise<PromptTemplate | null> {
  const result = await pool.query<PromptTemplate>(
    `SELECT id, workspace_id, name, category, template, variables, usage_count,
            created_by, created_at, updated_at
     FROM prompt_templates
     WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Render a template by substituting {{variableName}} placeholders.
 * Unknown variables are left as-is.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? (variables[key] ?? _match)
      : _match;
  });
}

export async function trackTemplateUsage(id: string, pool: Pool): Promise<void> {
  await pool
    .query(`UPDATE prompt_templates SET usage_count = usage_count + 1 WHERE id = $1`, [id])
    .catch(() => {});
}

export async function createTemplate(
  workspaceId: string,
  name: string,
  category: string,
  template: string,
  variables: string[],
  createdBy: string | null,
  pool: Pool,
): Promise<PromptTemplate> {
  const id = randomUUID();
  const result = await pool.query<PromptTemplate>(
    `INSERT INTO prompt_templates (id, workspace_id, name, category, template, variables, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, workspace_id, name, category, template, variables, usage_count,
               created_by, created_at, updated_at`,
    [
      id,
      workspaceId,
      name,
      category,
      template,
      JSON.stringify(variables),
      createdBy,
    ],
  );
  return result.rows[0]!;
}

export async function updateTemplate(
  id: string,
  workspaceId: string,
  updates: {
    name?: string;
    category?: string;
    template?: string;
    variables?: string[];
  },
  pool: Pool,
): Promise<PromptTemplate | null> {
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(updates.name);
  }
  if (updates.category !== undefined) {
    sets.push(`category = $${idx++}`);
    params.push(updates.category);
  }
  if (updates.template !== undefined) {
    sets.push(`template = $${idx++}`);
    params.push(updates.template);
  }
  if (updates.variables !== undefined) {
    sets.push(`variables = $${idx++}::jsonb`);
    params.push(JSON.stringify(updates.variables));
  }

  params.push(id, workspaceId);
  const result = await pool.query<PromptTemplate>(
    `UPDATE prompt_templates SET ${sets.join(", ")}
     WHERE id = $${idx++} AND workspace_id = $${idx++}
     RETURNING id, workspace_id, name, category, template, variables, usage_count,
               created_by, created_at, updated_at`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function deleteTemplate(
  id: string,
  workspaceId: string,
  pool: Pool,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM prompt_templates WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, workspaceId],
  );
  return (result.rows.length ?? 0) > 0;
}
