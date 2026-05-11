import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Jira Integration Skill ────────────────────────────────────────
// Interact with Jira: list issues, get issue, create issue, update
// issue, and search with JQL. Uses basic auth (email:token).

const JiraParams = z.object({
  operation: z
    .enum([
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "search_jql",
    ])
    .describe("Jira operation to perform"),
  projectKey: z
    .string()
    .optional()
    .describe("Jira project key (e.g. PROJ). Required for list_issues and create_issue."),
  issueKey: z
    .string()
    .optional()
    .describe("Jira issue key (e.g. PROJ-123). Required for get_issue and update_issue."),
  summary: z
    .string()
    .optional()
    .describe("Issue summary. Required for create_issue."),
  description: z
    .string()
    .optional()
    .describe("Issue description. Optional for create_issue and update_issue."),
  issueType: z
    .string()
    .default("Task")
    .describe("Issue type (e.g. Task, Bug, Story). Defaults to Task."),
  jql: z
    .string()
    .optional()
    .describe("JQL query string. Required for search_jql."),
});

function getJiraAuth(): { baseUrl: string; authHeader: string } | { error: string } {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) {
    return {
      error:
        "JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables must all be set.",
    };
  }

  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  return { baseUrl: baseUrl.replace(/\/$/, ""), authHeader };
}

async function jiraFetch(
  baseUrl: string,
  path: string,
  authHeader: string,
  options: { method?: string; body?: string } = {},
) {
  const response = await safeFetch(`${baseUrl}/rest/api/3${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
    ssrfProtection: false,
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: `Jira API ${response.status}: ${text}` };
  }

  return response.json();
}

const jiraIntegrationSkill: SkillDefinition = {
  name: "jira_integration",
  version: "1.0.0",

  manifest: {
    id: "jira_integration",
    name: "Jira Integration",
    description:
      "Interact with Jira: list project issues, get issue details, create issues, update issues, and search with JQL.",
    category: "execute",
    tools: ["jira_integration"],
    configFields: [
      {
        name: "baseUrl",
        type: "string",
        required: true,
        description: "Jira instance base URL (e.g. https://yourteam.atlassian.net)",
        envVar: "JIRA_BASE_URL",
      },
      {
        name: "email",
        type: "string",
        required: true,
        description: "Jira account email",
        envVar: "JIRA_EMAIL",
      },
      {
        name: "apiToken",
        type: "string",
        required: true,
        description: "Jira API token",
        envVar: "JIRA_API_TOKEN",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "jira_integration",
      description:
        "Perform Jira operations: list_issues, get_issue, create_issue, update_issue, search_jql.",
      parameters: JiraParams,

      async execute(params) {
        const auth = getJiraAuth();
        if ("error" in auth) return auth;
        const { baseUrl, authHeader } = auth;

        const { operation } = params;

        switch (operation) {
          case "list_issues": {
            if (!params.projectKey)
              return { error: "projectKey is required for list_issues." };
            const jql = encodeURIComponent(
              `project = "${params.projectKey}" ORDER BY updated DESC`,
            );
            return jiraFetch(
              baseUrl,
              `/search?jql=${jql}&maxResults=30`,
              authHeader,
            );
          }

          case "get_issue": {
            if (!params.issueKey)
              return { error: "issueKey is required for get_issue." };
            return jiraFetch(baseUrl, `/issue/${params.issueKey}`, authHeader);
          }

          case "create_issue": {
            if (!params.projectKey)
              return { error: "projectKey is required for create_issue." };
            if (!params.summary)
              return { error: "summary is required for create_issue." };
            return jiraFetch(baseUrl, `/issue`, authHeader, {
              method: "POST",
              body: JSON.stringify({
                fields: {
                  project: { key: params.projectKey },
                  summary: params.summary,
                  description: params.description
                    ? {
                        type: "doc",
                        version: 1,
                        content: [
                          {
                            type: "paragraph",
                            content: [
                              { type: "text", text: params.description },
                            ],
                          },
                        ],
                      }
                    : undefined,
                  issuetype: { name: params.issueType },
                },
              }),
            });
          }

          case "update_issue": {
            if (!params.issueKey)
              return { error: "issueKey is required for update_issue." };
            const fields: Record<string, unknown> = {};
            if (params.summary) fields.summary = params.summary;
            if (params.description) {
              fields.description = {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: params.description }],
                  },
                ],
              };
            }
            return jiraFetch(
              baseUrl,
              `/issue/${params.issueKey}`,
              authHeader,
              {
                method: "PUT",
                body: JSON.stringify({ fields }),
              },
            );
          }

          case "search_jql": {
            if (!params.jql)
              return { error: "jql is required for search_jql." };
            const jql = encodeURIComponent(params.jql);
            return jiraFetch(
              baseUrl,
              `/search?jql=${jql}&maxResults=30`,
              authHeader,
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
      skillId: "jira_integration",
      instructions:
        "You can interact with Jira using the `jira_integration` tool. Supported operations: list_issues (by project), get_issue, create_issue, update_issue, search_jql. Provide the operation and relevant fields (projectKey, issueKey, summary, description, jql).",
    };
  },
};

export default jiraIntegrationSkill;
