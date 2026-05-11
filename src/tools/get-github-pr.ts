import { z } from "zod";
import { registerTool } from "./registry.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

// ── get-github-pr ────────────────────────────────────────────────────
// Fetches pull request details from the GitHub API.
// SSRF guard: only api.github.com is allowed — no custom endpoints.

const Params = z.object({
  owner: z.string().describe("Repository owner (GitHub username or org)"),
  repo: z.string().describe("Repository name"),
  prNumber: z.number().int().positive().describe("Pull request number"),
  token: z
    .string()
    .optional()
    .describe("GitHub personal access token or Bearer token for private repos."),
});

const GITHUB_API_BASE = "https://api.github.com";

registerTool({
  name: "get-github-pr",
  description:
    "Fetches pull request details from the GitHub API. " +
    "Returns title, body/description, state, author, number of files changed, " +
    "additions/deletions, and the diff URL. " +
    "Params: owner (repo owner), repo (repo name), prNumber (integer), token (optional GitHub PAT).",
  parameters: Params,
  async execute(params) {
    const { owner, repo, prNumber, token } = params;

    // Validate owner/repo names to prevent path traversal
    if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
      return { error: "Invalid owner or repo name. Only alphanumeric, hyphens, underscores, and dots are allowed." };
    }

    const prUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;

    // SSRF guard — api.github.com should pass, but guard anyway
    if (await isBlockedUrl(prUrl)) {
      return { error: "SSRF guard blocked the GitHub API URL." };
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "astra-platform/1.0",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(prUrl, { headers });

      if (response.status === 404) {
        return { error: `Pull request #${prNumber} not found in ${owner}/${repo}.` };
      }
      if (response.status === 401 || response.status === 403) {
        return { error: "GitHub API returned 401/403. Provide a valid token for private repos." };
      }
      if (!response.ok) {
        return { error: `GitHub API returned ${response.status}: ${response.statusText}` };
      }

      const pr = await response.json() as Record<string, unknown>;

      const head = pr["head"] as Record<string, unknown> | undefined;
      const base = pr["base"] as Record<string, unknown> | undefined;
      const user = pr["user"] as Record<string, unknown> | undefined;
      const mergedBy = pr["merged_by"] as Record<string, unknown> | undefined;

      return {
        prNumber: pr["number"] as number,
        title: pr["title"] as string,
        body: ((pr["body"] as string) ?? "").slice(0, 5000),
        state: pr["state"] as string,
        draft: pr["draft"] as boolean,
        merged: pr["merged"] as boolean,
        mergeable: pr["mergeable"] as boolean | null,
        author: (user?.["login"] as string) ?? "unknown",
        authorUrl: (user?.["html_url"] as string) ?? "",
        mergedBy: (mergedBy?.["login"] as string) ?? null,
        filesChanged: pr["changed_files"] as number,
        additions: pr["additions"] as number,
        deletions: pr["deletions"] as number,
        commits: pr["commits"] as number,
        htmlUrl: pr["html_url"] as string,
        diffUrl: pr["diff_url"] as string,
        patchUrl: pr["patch_url"] as string,
        headBranch: (head?.["ref"] as string) ?? "",
        baseBranch: (base?.["ref"] as string) ?? "",
        createdAt: pr["created_at"] as string,
        updatedAt: pr["updated_at"] as string,
        mergedAt: (pr["merged_at"] as string) ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to fetch PR: ${msg}` };
    }
  },
});
