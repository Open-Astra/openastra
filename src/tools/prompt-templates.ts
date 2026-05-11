import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── prompt_template ─────────────────────────────────────────────────
// Workspace-scoped reusable prompt templates with versioning.
// Agents can save, list, apply, and rollback templates.
// Templates support {{variable}} interpolation.

const PromptTemplateParams = z.object({
  action: z
    .enum(["save", "list", "get", "apply", "delete", "history"])
    .describe("Action: save new template, list all, get by ID, apply with variables, delete, or view version history"),
  name: z.string().optional().describe("Template name (for save/get)"),
  content: z.string().optional().describe("Template content with {{variable}} placeholders (for save)"),
  template_id: z.string().optional().describe("Template ID (for get/apply/delete/history)"),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe("Variables to interpolate when applying (for apply)"),
  category: z
    .string()
    .optional()
    .describe("Category for organizing templates (for save/list)"),
});

registerTool({
  name: "prompt_template",
  description:
    "Manage reusable prompt templates in the workspace. Save templates with {{variable}} placeholders, list/search templates, apply with variable interpolation, and view version history.",
  parameters: PromptTemplateParams,

  async execute(params, ctx) {
    const pool = getPool();
    const workspaceId = ctx.workspaceId ?? `personal:${ctx.uid}`;

    switch (params.action) {
      case "save": {
        if (!params.name || !params.content) {
          return { error: "name and content are required for save" };
        }

        const id = randomUUID();
        const variables = extractVariables(params.content);

        // Check for existing template with same name — create new version
        const { rows: existing } = await pool.query<{ id: string; version: number }>(
          `SELECT id, (value->>'version')::int AS version
           FROM workspace_templates
           WHERE workspace_id = $1 AND value->>'name' = $2
           ORDER BY (value->>'version')::int DESC LIMIT 1`,
          [workspaceId, params.name],
        );

        const version = existing.length > 0 ? existing[0]!.version + 1 : 1;

        const value = {
          name: params.name,
          content: params.content,
          category: params.category ?? "general",
          variables,
          version,
          createdBy: ctx.uid,
          createdAt: Date.now(),
        };

        await pool.query(
          `INSERT INTO workspace_templates (id, workspace_id, value, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
          [id, workspaceId, JSON.stringify(value)],
        );

        return {
          result: "Template saved",
          templateId: id,
          name: params.name,
          version,
          variables,
        };
      }

      case "list": {
        const categoryFilter = params.category
          ? ` AND value->>'category' = '${params.category}'`
          : "";

        const { rows } = await pool.query<{
          id: string;
          value: { name: string; category: string; version: number; variables: string[]; createdAt: number };
        }>(
          `SELECT id, value FROM workspace_templates
           WHERE workspace_id = $1 ${categoryFilter}
           ORDER BY value->>'name', (value->>'version')::int DESC`,
          [workspaceId],
        );

        // Deduplicate — show only latest version per name
        const latest = new Map<string, typeof rows[0]>();
        for (const row of rows) {
          if (!latest.has(row.value.name)) {
            latest.set(row.value.name, row);
          }
        }

        const templates = [...latest.values()].map((r) => ({
          id: r.id,
          name: r.value.name,
          category: r.value.category,
          version: r.value.version,
          variables: r.value.variables,
        }));

        return { result: `${templates.length} template(s)`, templates };
      }

      case "get": {
        if (!params.template_id && !params.name) {
          return { error: "template_id or name required" };
        }

        let query: string;
        let queryParams: unknown[];

        if (params.template_id) {
          query = "SELECT id, value FROM workspace_templates WHERE id = $1 AND workspace_id = $2";
          queryParams = [params.template_id, workspaceId];
        } else {
          query = `SELECT id, value FROM workspace_templates
                   WHERE workspace_id = $1 AND value->>'name' = $2
                   ORDER BY (value->>'version')::int DESC LIMIT 1`;
          queryParams = [workspaceId, params.name!];
        }

        const { rows } = await pool.query<{
          id: string;
          value: { name: string; content: string; category: string; version: number; variables: string[] };
        }>(query, queryParams);

        if (rows.length === 0) return { error: "Template not found" };

        return {
          templateId: rows[0]!.id,
          ...rows[0]!.value,
        };
      }

      case "apply": {
        if (!params.template_id && !params.name) {
          return { error: "template_id or name required" };
        }

        let query: string;
        let queryParams: unknown[];

        if (params.template_id) {
          query = "SELECT value FROM workspace_templates WHERE id = $1 AND workspace_id = $2";
          queryParams = [params.template_id, workspaceId];
        } else {
          query = `SELECT value FROM workspace_templates
                   WHERE workspace_id = $1 AND value->>'name' = $2
                   ORDER BY (value->>'version')::int DESC LIMIT 1`;
          queryParams = [workspaceId, params.name!];
        }

        const { rows } = await pool.query<{
          value: { content: string; name: string; variables: string[] };
        }>(query, queryParams);

        if (rows.length === 0) return { error: "Template not found" };

        const template = rows[0]!.value;
        let rendered = template.content;
        const vars = params.variables ?? {};
        const missing: string[] = [];

        for (const v of template.variables) {
          if (vars[v] !== undefined) {
            rendered = rendered.replaceAll(`{{${v}}}`, vars[v]!);
          } else {
            missing.push(v);
          }
        }

        return {
          result: "Template applied",
          name: template.name,
          rendered,
          missingVariables: missing.length > 0 ? missing : undefined,
        };
      }

      case "delete": {
        if (!params.template_id) return { error: "template_id required" };

        await pool.query(
          "DELETE FROM workspace_templates WHERE id = $1 AND workspace_id = $2",
          [params.template_id, workspaceId],
        );

        return { result: "Template deleted", templateId: params.template_id };
      }

      case "history": {
        if (!params.name) return { error: "name required for history" };

        const { rows } = await pool.query<{
          id: string;
          value: { name: string; version: number; createdAt: number; createdBy: string };
        }>(
          `SELECT id, value FROM workspace_templates
           WHERE workspace_id = $1 AND value->>'name' = $2
           ORDER BY (value->>'version')::int DESC LIMIT 20`,
          [workspaceId, params.name],
        );

        const versions = rows.map((r) => ({
          templateId: r.id,
          version: r.value.version,
          createdAt: r.value.createdAt,
          createdBy: r.value.createdBy,
        }));

        return { result: `${versions.length} version(s)`, name: params.name, versions };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
}
