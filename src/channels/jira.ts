// ── Jira Bidirectional Sync ────────────────────────────────────────
// Helpers for Jira integration: config lookup, event parsing, comment posting.
// The HTTP router lives in src/gateway/channels/jira.ts (HMAC-verified).
// This module only exports helper functions — no unauthenticated routes.
//
// Security: all outbound calls to Jira base URL go through SSRF guard.
// Jira API tokens are read from encrypted workspace_secrets (JIRA_API_TOKEN).

import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { getWorkspaceSecret } from "../workspaces/secrets.js";

// ── Jira config lookup ─────────────────────────────────────────────

interface JiraSyncConfig {
  id: string;
  workspace_id: string;
  jira_base_url: string;
  api_token: string;
  project_key: string;
  agent_id: string;
  enabled: boolean;
}

async function getJiraConfig(workspaceId: string): Promise<JiraSyncConfig | null> {
  const pool = getPool();
  const result = await pool.query<JiraSyncConfig>(
    `SELECT id, workspace_id, jira_base_url, project_key, agent_id, enabled
     FROM jira_sync_configs
     WHERE workspace_id = $1 AND enabled = true
     LIMIT 1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;

  // Read token from encrypted workspace secrets; fall back to DB column for migration
  const token = await getWorkspaceSecret(workspaceId, "JIRA_API_TOKEN");
  row.api_token = token ?? row.api_token ?? "";
  return row;
}

// ── Jira event text builder ────────────────────────────────────────

function buildJiraEventText(
  event: Record<string, unknown>,
): string | null {
  const webhookEvent = (event["webhookEvent"] as string) ?? "";
  const issue = event["issue"] as Record<string, unknown> | undefined;

  if (!issue) return null;

  const issueKey = (issue["key"] as string) ?? "";
  const fields = issue["fields"] as Record<string, unknown> | undefined;
  const summary = (fields?.["summary"] as string) ?? "";
  const description = (
    (fields?.["description"] as string) ??
    ((fields?.["description"] as Record<string, unknown>)?.["content"] as string) ??
    ""
  );

  const statusField = fields?.["status"] as Record<string, unknown> | undefined;
  const status = (statusField?.["name"] as string) ?? "unknown";
  const priorityField = fields?.["priority"] as Record<string, unknown> | undefined;
  const priority = (priorityField?.["name"] as string) ?? "unknown";
  const user = event["user"] as Record<string, unknown> | undefined;
  const actorName = (user?.["displayName"] as string) ?? "jira-user";

  if (webhookEvent === "jira:issue_created") {
    const desc = typeof description === "string" ? description.slice(0, 2000) : "";
    return (
      `Jira issue created by ${actorName}:\n` +
      `Key: ${issueKey}\n` +
      `Summary: ${summary}\n` +
      `Description: ${desc}\n` +
      `Status: ${status}\n` +
      `Priority: ${priority}`
    );
  }

  if (webhookEvent === "jira:issue_updated") {
    const changelog = event["changelog"] as Record<string, unknown> | undefined;
    const items = (changelog?.["items"] as Array<Record<string, unknown>>) ?? [];
    const changes = items
      .map((i) => `${i["field"] as string}: ${i["fromString"] as string} → ${i["toString"] as string}`)
      .join(", ");
    return (
      `Jira issue updated by ${actorName}:\n` +
      `Key: ${issueKey}\n` +
      `Summary: ${summary}\n` +
      `Changes: ${changes || "fields updated"}`
    );
  }

  if (webhookEvent === "comment_created" || webhookEvent === "comment_updated") {
    const comment = event["comment"] as Record<string, unknown> | undefined;
    const commentBody = ((comment?.["body"] as string) ?? "").slice(0, 2000);
    const commentAuthor =
      ((comment?.["author"] as Record<string, unknown>)?.["displayName"] as string) ?? actorName;
    return (
      `Jira comment on ${issueKey} by ${commentAuthor}:\n` +
      `${commentBody}`
    );
  }

  return null;
}

// ── Post Jira comment ──────────────────────────────────────────────

/**
 * Post a comment on a Jira issue via the Jira REST API.
 * Uses Basic Auth: email:api_token (standard Jira Cloud approach).
 */
export async function postJiraComment(
  jiraBaseUrl: string,
  issueKey: string,
  body: string,
  apiToken: string,
): Promise<{ success: boolean; commentId?: string; error?: string }> {
  // Strip trailing slash from base URL
  const base = jiraBaseUrl.replace(/\/$/, "");
  const url = `${base}/rest/api/3/issue/${issueKey}/comment`;

  if (await isBlockedUrl(url)) {
    return { success: false, error: "SSRF guard blocked Jira API URL" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${apiToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { success: false, error: `Jira API returned ${response.status}: ${text.slice(0, 200)}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return { success: true, commentId: data["id"] as string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to post Jira comment: ${msg}` };
  }
}

// ── Internal helpers ─────────────────────────────────────────────
// No router is exported from this module. The mounted Jira router lives
// in src/gateway/channels/jira.ts and uses HMAC-SHA256 verification.
// This module only exports postJiraComment() and buildJiraEventText()
// for use by the gateway router and internal agents.

export { buildJiraEventText, getJiraConfig };
