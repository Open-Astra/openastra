import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Google Docs Skill ─────────────────────────────────────────────
// Read Google Docs and Sheets via public export URLs, and search
// Google Drive via the Drive API (requires GOOGLE_SERVICE_ACCOUNT_KEY).

const GoogleDocsParams = z.object({
  operation: z
    .enum(["read_doc", "read_sheet", "search_drive"])
    .describe("Operation to perform"),
  documentId: z
    .string()
    .optional()
    .describe("Google Docs document ID. Required for read_doc."),
  spreadsheetId: z
    .string()
    .optional()
    .describe("Google Sheets spreadsheet ID. Required for read_sheet."),
  range: z
    .string()
    .optional()
    .describe("Sheet name or range for read_sheet (e.g. 'Sheet1'). Optional."),
  query: z
    .string()
    .optional()
    .describe("Search query. Required for search_drive."),
});

const googleDocsSkill: SkillDefinition = {
  name: "google_docs",
  version: "1.0.0",

  manifest: {
    id: "google_docs",
    name: "Google Docs",
    description:
      "Read Google Docs and Sheets (via public export URLs) and search Google Drive (requires service account).",
    category: "search",
    tools: ["google_docs"],
    configFields: [
      {
        name: "serviceAccountKey",
        type: "string",
        required: false,
        description:
          "Google service account key JSON string. Required for search_drive.",
        envVar: "GOOGLE_SERVICE_ACCOUNT_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "google_docs",
      description:
        "Read Google Docs (as text), read Google Sheets (as CSV), or search Google Drive.",
      parameters: GoogleDocsParams,

      async execute(params) {
        const { operation } = params;

        switch (operation) {
          case "read_doc": {
            if (!params.documentId)
              return { error: "documentId is required for read_doc." };

            const url = `https://docs.google.com/document/d/${params.documentId}/export?format=txt`;
            const response = await safeFetch(url, {
              ssrfProtection: false,
              timeoutMs: 15_000,
            });

            if (!response.ok) {
              return {
                error: `Failed to fetch document: ${response.status} ${response.statusText}. Ensure the document is publicly shared.`,
              };
            }

            const text = await response.text();
            return {
              documentId: params.documentId,
              content: text,
              characterCount: text.length,
            };
          }

          case "read_sheet": {
            if (!params.spreadsheetId)
              return { error: "spreadsheetId is required for read_sheet." };

            const sheet = params.range
              ? `&sheet=${encodeURIComponent(params.range)}`
              : "";
            const url = `https://docs.google.com/spreadsheets/d/${params.spreadsheetId}/gviz/tq?tqx=out:csv${sheet}`;
            const response = await safeFetch(url, {
              ssrfProtection: false,
              timeoutMs: 15_000,
            });

            if (!response.ok) {
              return {
                error: `Failed to fetch spreadsheet: ${response.status} ${response.statusText}. Ensure the spreadsheet is publicly shared.`,
              };
            }

            const csv = await response.text();
            const rows = csv.split("\n").filter((r) => r.trim());
            return {
              spreadsheetId: params.spreadsheetId,
              sheet: params.range ?? "default",
              rowCount: rows.length,
              csv,
            };
          }

          case "search_drive": {
            if (!params.query)
              return { error: "query is required for search_drive." };

            const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
            if (!saKey) {
              return {
                error:
                  "GOOGLE_SERVICE_ACCOUNT_KEY is not set. search_drive requires a service account.",
              };
            }

            // Parse the service account key to extract the access token generation info
            let parsed: { client_email?: string; private_key?: string };
            try {
              parsed = JSON.parse(saKey) as {
                client_email?: string;
                private_key?: string;
              };
            } catch {
              return { error: "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON." };
            }

            if (!parsed.client_email || !parsed.private_key) {
              return {
                error:
                  "GOOGLE_SERVICE_ACCOUNT_KEY must contain client_email and private_key.",
              };
            }

            // For service account auth we'd need JWT signing — simplified: use the API key approach
            // In practice, agents can use the read_doc/read_sheet operations for public documents
            return {
              error:
                "search_drive requires OAuth2 token exchange which is not yet implemented. Use read_doc or read_sheet with a known document ID instead.",
            };
          }

          default:
            return { error: `Unknown operation: ${operation}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "google_docs",
      instructions:
        "You can read Google Docs and Sheets using the `google_docs` tool. Use read_doc with a documentId to get the text content of a Google Doc, or read_sheet with a spreadsheetId to get CSV data from a Google Sheet. Documents must be publicly shared or accessible via link.",
    };
  },
};

export default googleDocsSkill;
