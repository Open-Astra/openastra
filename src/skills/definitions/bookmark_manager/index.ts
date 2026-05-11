import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Bookmark Manager Skill ──────────────────────────────────────────
// Save, tag, search, and organize URL bookmarks with Postgres persistence.

const AddBookmarkParams = z.object({
  url: z.string().url().describe("URL to bookmark"),
  title: z.string().describe("Bookmark title"),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const SearchBookmarksParams = z.object({
  query: z.string().optional().describe("Search in title, URL, or description"),
  tag: z.string().optional().describe("Filter by tag"),
  limit: z.number().int().min(1).max(50).default(20),
});

const DeleteBookmarkParams = z.object({
  id: z.number().int().describe("Bookmark ID to delete"),
});

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, url)
)`;

const bookmarkManagerSkill: SkillDefinition = {
  name: "bookmark_manager",
  version: "1.0.0",

  manifest: {
    id: "bookmark_manager",
    name: "Bookmark Manager",
    description: "Save, tag, search, and organize URL bookmarks with persistent storage.",
    category: "execute",
    tools: ["bookmark_add", "bookmark_search", "bookmark_delete"],
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
      name: "bookmark_add",
      description: "Save a URL as a bookmark with title, description, and tags.",
      parameters: AddBookmarkParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `INSERT INTO bookmarks (uid, url, title, description, tags)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (uid, url) DO UPDATE SET title = $3, description = $4, tags = $5
           RETURNING id`,
          [toolCtx.uid, params.url, params.title, params.description ?? null, params.tags],
        );

        return { success: true, id: (result.rows[0] as { id: number }).id, url: params.url, tags: params.tags };
      },
    });

    ctx.registerTool({
      name: "bookmark_search",
      description: "Search bookmarks by text query and/or tag.",
      parameters: SearchBookmarksParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const conditions = ["uid = $1"];
        const queryParams: unknown[] = [toolCtx.uid];
        let idx = 2;

        if (params.query) {
          conditions.push(`(title ILIKE $${idx} OR url ILIKE $${idx} OR description ILIKE $${idx})`);
          queryParams.push(`%${params.query}%`);
          idx++;
        }
        if (params.tag) {
          conditions.push(`$${idx} = ANY(tags)`);
          queryParams.push(params.tag);
          idx++;
        }

        queryParams.push(params.limit);
        const result = await getPool().query(
          `SELECT id, url, title, description, tags, created_at
           FROM bookmarks WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC LIMIT $${idx}`,
          queryParams,
        );

        return { count: result.rows.length, bookmarks: result.rows };
      },
    });

    ctx.registerTool({
      name: "bookmark_delete",
      description: "Delete a bookmark by ID.",
      parameters: DeleteBookmarkParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `DELETE FROM bookmarks WHERE id = $1 AND uid = $2`,
          [params.id, toolCtx.uid],
        );
        return result.rowCount! > 0
          ? { success: true, deleted: params.id }
          : { error: `Bookmark ${params.id} not found.` };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "bookmark_manager",
      instructions: "You can manage bookmarks with `bookmark_add` (save URL with tags), `bookmark_search` (find by text/tag), and `bookmark_delete`. Bookmarks persist in Postgres.",
    };
  },
};

export default bookmarkManagerSkill;
