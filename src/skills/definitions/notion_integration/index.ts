import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Notion Integration Skill ──────────────────────────────────────
// Interact with Notion: search, get/create pages, get/query databases.
// Requires NOTION_API_KEY (integration token).

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const NotionParams = z.object({
  operation: z
    .enum([
      "search",
      "get_page",
      "create_page",
      "get_database",
      "query_database",
    ])
    .describe("Notion operation to perform"),
  query: z
    .string()
    .optional()
    .describe("Search query. Required for search."),
  pageId: z
    .string()
    .optional()
    .describe("Page ID. Required for get_page."),
  databaseId: z
    .string()
    .optional()
    .describe("Database ID. Required for get_database, query_database, and create_page (as parent)."),
  properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Page properties object. Required for create_page."),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Database query filter. Optional for query_database."),
});

async function notionFetch(
  path: string,
  token: string,
  options: { method?: string; body?: string } = {},
) {
  const response = await safeFetch(`${NOTION_API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
    ssrfProtection: false,
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: `Notion API ${response.status}: ${text}` };
  }

  return response.json();
}

const notionIntegrationSkill: SkillDefinition = {
  name: "notion_integration",
  version: "1.0.0",

  manifest: {
    id: "notion_integration",
    name: "Notion Integration",
    description:
      "Interact with Notion: search workspace, get/create pages, get/query databases.",
    category: "execute",
    tools: ["notion_integration"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: true,
        description: "Notion integration API key",
        envVar: "NOTION_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "notion_integration",
      description:
        "Perform Notion operations: search, get_page, create_page, get_database, query_database.",
      parameters: NotionParams,

      async execute(params) {
        const token = process.env.NOTION_API_KEY;
        if (!token) {
          return { error: "NOTION_API_KEY environment variable is not set." };
        }

        const { operation } = params;

        switch (operation) {
          case "search": {
            return notionFetch("/search", token, {
              method: "POST",
              body: JSON.stringify({
                query: params.query ?? "",
                page_size: 20,
              }),
            });
          }

          case "get_page": {
            if (!params.pageId)
              return { error: "pageId is required for get_page." };
            return notionFetch(`/pages/${params.pageId}`, token);
          }

          case "create_page": {
            if (!params.databaseId)
              return {
                error: "databaseId is required as the parent for create_page.",
              };
            if (!params.properties)
              return { error: "properties are required for create_page." };
            return notionFetch("/pages", token, {
              method: "POST",
              body: JSON.stringify({
                parent: { database_id: params.databaseId },
                properties: params.properties,
              }),
            });
          }

          case "get_database": {
            if (!params.databaseId)
              return { error: "databaseId is required for get_database." };
            return notionFetch(`/databases/${params.databaseId}`, token);
          }

          case "query_database": {
            if (!params.databaseId)
              return { error: "databaseId is required for query_database." };
            return notionFetch(
              `/databases/${params.databaseId}/query`,
              token,
              {
                method: "POST",
                body: JSON.stringify({
                  filter: params.filter,
                  page_size: 30,
                }),
              },
            );
          }

          default:
            return { error: `Unknown operation: ${operation}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "notion_integration",
      instructions:
        "You can interact with Notion using the `notion_integration` tool. Supported operations: search (workspace-wide), get_page, create_page (in a database), get_database, query_database (with optional filter). Provide the operation and relevant IDs/fields.",
    };
  },
};

export default notionIntegrationSkill;
