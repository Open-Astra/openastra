import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

// ── jira-create-issue ────────────────────────────────────────────────
// Creates a Jira issue using the Jira REST API.
// Looks up the Jira base URL and API token from jira_sync_configs for
// the given workspaceId. Only works when a Jira sync config exists.

const Params = z.object({
  workspaceId: z
    .string()
    .describe("Astra workspace ID — used to look up Jira sync config."),
  summary: z
    .string()
    .max(255)
    .describe("Issue title/summary (required)."),
  description: z
    .string()
    .max(32768)
    .optional()
    .describe("Issue description text."),
  issueType: z
    .string()
    .optional()
    .default("Task")
    .describe("Jira issue type (e.g. 'Bug', 'Story', 'Task', 'Epic'). Defaults to 'Task'."),
  priority: z
    .string()
    .optional()
    .describe("Priority name (e.g. 'High', 'Medium', 'Low'). Optional."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels to apply to the issue."),
  assignee: z
    .string()
    .optional()
    .describe("Jira accountId of the assignee. Optional."),
});

interface JiraSyncConfig {
  jira_base_url: string;
  api_token: string;
  project_key: string;
}

async function getJiraConfig(workspaceId: string): Promise<JiraSyncConfig | null> {
  const pool = getPool();
  const result = await pool.query<JiraSyncConfig>(
    `SELECT jira_base_url, api_token, project_key
     FROM jira_sync_configs
     WHERE workspace_id = $1 AND enabled = true
     LIMIT 1`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

registerTool({
  name: "jira-create-issue",
  description:
    "Creates a Jira issue in the project configured for the given workspace. " +
    "Requires a Jira sync config (jira_sync_configs) to be set up for the workspace. " +
    "Returns the new issue key, ID, and URL. " +
    "Params: workspaceId, summary (required), description, issueType (default: Task), " +
    "priority, labels, assignee (Jira accountId).",
  parameters: Params,
  async execute(params) {
    const { workspaceId, summary, description, issueType, priority, labels, assignee } = params;

    // Look up Jira config for workspace
    let config: JiraSyncConfig | null;
    try {
      config = await getJiraConfig(workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to look up Jira config: ${msg}` };
    }

    if (!config) {
      return {
        error: `No enabled Jira sync config found for workspace: ${workspaceId}. ` +
          "Configure a Jira integration via POST /jira/config first.",
      };
    }

    const base = config.jira_base_url.replace(/\/$/, "");
    const createUrl = `${base}/rest/api/3/issue`;

    // SSRF guard
    if (await isBlockedUrl(createUrl)) {
      return { error: "SSRF guard blocked the Jira API URL." };
    }

    // Build the issue fields object
    const fields: Record<string, unknown> = {
      project: { key: config.project_key },
      summary,
      issuetype: { name: issueType ?? "Task" },
    };

    if (description) {
      fields["description"] = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      };
    }

    if (priority) {
      fields["priority"] = { name: priority };
    }

    if (labels && labels.length > 0) {
      fields["labels"] = labels;
    }

    if (assignee) {
      fields["assignee"] = { accountId: assignee };
    }

    try {
      const response = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${config.api_token}`,
          Accept: "application/json",
        },
        body: JSON.stringify({ fields }),
      });

      if (response.status === 401 || response.status === 403) {
        return { error: "Jira API returned 401/403. Check the API token in jira_sync_configs." };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { error: `Jira API returned ${response.status}: ${text.slice(0, 300)}` };
      }

      const data = await response.json() as Record<string, unknown>;
      const issueKey = data["key"] as string;
      const issueId = data["id"] as string;
      const issueUrl = `${base}/browse/${issueKey}`;

      return {
        issueKey,
        issueId,
        url: issueUrl,
        projectKey: config.project_key,
        summary,
        issueType: issueType ?? "Task",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create Jira issue: ${msg}` };
    }
  },
});
