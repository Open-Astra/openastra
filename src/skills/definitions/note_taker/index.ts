import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Note Taker Skill ────────────────────────────────────────────────
// Persistent structured notes with tags and full-text search.

const CreateNoteParams = z.object({
  title: z.string().describe("Note title"),
  content: z.string().describe("Note content (supports markdown)"),
  tags: z.array(z.string()).default([]).describe("Tags for categorization"),
});

const SearchNotesParams = z.object({
  query: z.string().optional().describe("Search in title and content"),
  tag: z.string().optional().describe("Filter by tag"),
  limit: z.number().int().min(1).max(50).default(20),
});

const UpdateNoteParams = z.object({
  id: z.number().int().describe("Note ID to update"),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const DeleteNoteParams = z.object({
  id: z.number().int().describe("Note ID to delete"),
});

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)`;

const noteTakerSkill: SkillDefinition = {
  name: "note_taker",
  version: "1.0.0",

  manifest: {
    id: "note_taker",
    name: "Note Taker",
    description: "Create, search, update, and delete persistent notes with tags and full-text search.",
    category: "execute",
    tools: ["note_create", "note_search", "note_update", "note_delete"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    let tableReady = false;
    const ensureTable = async () => {
      if (tableReady) return;
      await getPool().query(ENSURE_TABLE);
      tableReady = true;
    };

    ctx.registerTool({
      name: "note_create",
      description: "Create a new note with title, content, and optional tags.",
      parameters: CreateNoteParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `INSERT INTO notes (uid, title, content, tags) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
          [toolCtx.uid, params.title, params.content, params.tags],
        );

        const row = result.rows[0] as { id: number; created_at: Date };
        return { success: true, id: row.id, title: params.title, tags: params.tags };
      },
    });

    ctx.registerTool({
      name: "note_search",
      description: "Search notes by text query and/or tag.",
      parameters: SearchNotesParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const conditions = ["uid = $1"];
        const queryParams: unknown[] = [toolCtx.uid];
        let paramIdx = 2;

        if (params.query) {
          conditions.push(`(title ILIKE $${paramIdx} OR content ILIKE $${paramIdx})`);
          queryParams.push(`%${params.query}%`);
          paramIdx++;
        }

        if (params.tag) {
          conditions.push(`$${paramIdx} = ANY(tags)`);
          queryParams.push(params.tag);
          paramIdx++;
        }

        queryParams.push(params.limit);
        const result = await getPool().query(
          `SELECT id, title, content, tags, created_at, updated_at
           FROM notes WHERE ${conditions.join(" AND ")}
           ORDER BY updated_at DESC LIMIT $${paramIdx}`,
          queryParams,
        );

        return {
          count: result.rows.length,
          notes: (result.rows as Array<{ id: number; title: string; content: string; tags: string[]; created_at: Date; updated_at: Date }>).map((n) => ({
            ...n,
            content: n.content.slice(0, 500),
          })),
        };
      },
    });

    ctx.registerTool({
      name: "note_update",
      description: "Update an existing note's title, content, or tags.",
      parameters: UpdateNoteParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const sets: string[] = ["updated_at = NOW()"];
        const queryParams: unknown[] = [];
        let paramIdx = 1;

        if (params.title) { sets.push(`title = $${paramIdx}`); queryParams.push(params.title); paramIdx++; }
        if (params.content) { sets.push(`content = $${paramIdx}`); queryParams.push(params.content); paramIdx++; }
        if (params.tags) { sets.push(`tags = $${paramIdx}`); queryParams.push(params.tags); paramIdx++; }

        queryParams.push(params.id, toolCtx.uid);

        const result = await getPool().query(
          `UPDATE notes SET ${sets.join(", ")} WHERE id = $${paramIdx} AND uid = $${paramIdx + 1} RETURNING id`,
          queryParams,
        );

        return result.rowCount! > 0
          ? { success: true, updated: params.id }
          : { error: `Note ${params.id} not found.` };
      },
    });

    ctx.registerTool({
      name: "note_delete",
      description: "Delete a note by ID.",
      parameters: DeleteNoteParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `DELETE FROM notes WHERE id = $1 AND uid = $2`,
          [params.id, toolCtx.uid],
        );
        return result.rowCount! > 0
          ? { success: true, deleted: params.id }
          : { error: `Note ${params.id} not found.` };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "note_taker",
      instructions: "You can manage notes with `note_create` (new note with tags), `note_search` (find by text/tag), `note_update` (modify), and `note_delete`. Notes persist in Postgres.",
    };
  },
};

export default noteTakerSkill;
