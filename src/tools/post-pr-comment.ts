import { z } from "zod";
import { registerTool } from "./registry.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

// ── post-pr-comment ──────────────────────────────────────────────────
// Posts a review comment to a GitHub pull request via the GitHub REST API.
// Uses the PR Issues comments endpoint (visible in the conversation thread).
// SSRF guard applied before any outbound request.

const Params = z.object({
  owner: z.string().describe("Repository owner (GitHub username or org)"),
  repo: z.string().describe("Repository name"),
  prNumber: z.number().int().positive().describe("Pull request number"),
  body: z.string().max(65536).describe("Comment body text (Markdown supported)"),
  token: z.string().describe("GitHub personal access token or Bearer token"),
});

const GITHUB_API_BASE = "https://api.github.com";

registerTool({
  name: "post-pr-comment",
  description:
    "Posts a comment to a GitHub pull request conversation thread. " +
    "Requires a GitHub personal access token (token) with repo scope. " +
    "Params: owner, repo, prNumber, body (Markdown), token.",
  parameters: Params,
  async execute(params) {
    const { owner, repo, prNumber, body, token } = params;

    // Validate owner/repo to prevent path traversal
    if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
      return { error: "Invalid owner or repo name. Only alphanumeric, hyphens, underscores, and dots are allowed." };
    }

    // GitHub PR comments go through the Issues API endpoint
    const commentUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;

    // SSRF guard
    if (await isBlockedUrl(commentUrl)) {
      return { error: "SSRF guard blocked the GitHub API URL." };
    }

    try {
      const response = await fetch(commentUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "astra-platform/1.0",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ body }),
      });

      if (response.status === 401 || response.status === 403) {
        return { error: "GitHub API returned 401/403. Check that your token has 'repo' scope." };
      }
      if (response.status === 404) {
        return { error: `PR #${prNumber} not found in ${owner}/${repo}.` };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { error: `GitHub API returned ${response.status}: ${text.slice(0, 200)}` };
      }

      const comment = await response.json() as Record<string, unknown>;
      return {
        commentId: comment["id"] as number,
        url: comment["html_url"] as string,
        createdAt: comment["created_at"] as string,
        body: ((comment["body"] as string) ?? "").slice(0, 500),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to post PR comment: ${msg}` };
    }
  },
});
