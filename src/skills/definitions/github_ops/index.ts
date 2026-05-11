import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── GitHub Ops Skill ──────────────────────────────────────────────
// Perform GitHub API operations: list repos, get repo, list/create
// issues, list/get PRs, and search code. Requires GITHUB_TOKEN.

const GITHUB_API = "https://api.github.com";

const GithubOpsParams = z.object({
  operation: z
    .enum([
      "list_repos",
      "get_repo",
      "list_issues",
      "create_issue",
      "list_prs",
      "get_pr",
      "search_code",
      "create_pr",
      "list_checks",
      "merge_pr",
      "list_branches",
    ])
    .describe("GitHub operation to perform"),
  owner: z
    .string()
    .optional()
    .describe("Repository owner (user or org). Required for repo-level operations."),
  repo: z
    .string()
    .optional()
    .describe("Repository name. Required for repo-level operations."),
  title: z
    .string()
    .optional()
    .describe("Issue/PR title. Required for create_issue and create_pr."),
  body: z
    .string()
    .optional()
    .describe("Issue/PR body. Optional for create_issue and create_pr."),
  query: z
    .string()
    .optional()
    .describe("Search query. Required for search_code."),
  prNumber: z
    .number()
    .int()
    .optional()
    .describe("Pull request number. Required for get_pr and merge_pr."),
  head: z
    .string()
    .optional()
    .describe("Head branch for create_pr"),
  base: z
    .string()
    .optional()
    .describe("Base branch for create_pr (default: main)"),
  method: z
    .enum(["merge", "squash", "rebase"])
    .optional()
    .describe("Merge method for merge_pr"),
  ref: z
    .string()
    .optional()
    .describe("Git ref for list_checks (branch/SHA)"),
});

async function githubFetch(
  path: string,
  token: string,
  options: { method?: string; body?: string } = {},
) {
  const response = await safeFetch(`${GITHUB_API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
    ssrfProtection: false,
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: `GitHub API ${response.status}: ${text}` };
  }

  return response.json();
}

const githubOpsSkill: SkillDefinition = {
  name: "github_ops",
  version: "1.0.0",

  manifest: {
    id: "github_ops",
    name: "GitHub Ops",
    description:
      "Interact with GitHub: list repos, get repo info, list/create issues, list/get/create/merge pull requests, list branches, list checks, and search code.",
    category: "execute",
    tools: ["github_ops"],
    configFields: [
      {
        name: "token",
        type: "string",
        required: true,
        description: "GitHub personal access token",
        envVar: "GITHUB_TOKEN",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "github_ops",
      description:
        "Perform GitHub operations: list repos, get repo, list/create issues, list/get/create/merge PRs, list branches, list checks, search code.",
      parameters: GithubOpsParams,

      async execute(params) {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          return { error: "GITHUB_TOKEN environment variable is not set." };
        }

        const { operation, owner, repo } = params;

        switch (operation) {
          case "list_repos": {
            if (!owner) return { error: "owner is required for list_repos." };
            return githubFetch(`/users/${owner}/repos?per_page=30&sort=updated`, token);
          }

          case "get_repo": {
            if (!owner || !repo)
              return { error: "owner and repo are required for get_repo." };
            return githubFetch(`/repos/${owner}/${repo}`, token);
          }

          case "list_issues": {
            if (!owner || !repo)
              return { error: "owner and repo are required for list_issues." };
            return githubFetch(
              `/repos/${owner}/${repo}/issues?per_page=30&state=open`,
              token,
            );
          }

          case "create_issue": {
            if (!owner || !repo)
              return { error: "owner and repo are required for create_issue." };
            if (!params.title)
              return { error: "title is required for create_issue." };
            return githubFetch(`/repos/${owner}/${repo}/issues`, token, {
              method: "POST",
              body: JSON.stringify({
                title: params.title,
                body: params.body ?? "",
              }),
            });
          }

          case "list_prs": {
            if (!owner || !repo)
              return { error: "owner and repo are required for list_prs." };
            return githubFetch(
              `/repos/${owner}/${repo}/pulls?per_page=30&state=open`,
              token,
            );
          }

          case "get_pr": {
            if (!owner || !repo)
              return { error: "owner and repo are required for get_pr." };
            if (params.prNumber == null)
              return { error: "prNumber is required for get_pr." };
            return githubFetch(
              `/repos/${owner}/${repo}/pulls/${params.prNumber}`,
              token,
            );
          }

          case "search_code": {
            if (!params.query)
              return { error: "query is required for search_code." };
            const q = encodeURIComponent(params.query);
            return githubFetch(`/search/code?q=${q}&per_page=20`, token);
          }

          case "create_pr": {
            if (!owner || !repo)
              return { error: "owner and repo are required for create_pr." };
            if (!params.title)
              return { error: "title is required for create_pr." };
            if (!params.head)
              return { error: "head branch is required for create_pr." };
            return githubFetch(`/repos/${owner}/${repo}/pulls`, token, {
              method: "POST",
              body: JSON.stringify({
                title: params.title,
                body: params.body ?? "",
                head: params.head,
                base: params.base ?? "main",
              }),
            });
          }

          case "list_checks": {
            if (!owner || !repo)
              return { error: "owner and repo are required for list_checks." };
            if (!params.ref)
              return { error: "ref is required for list_checks." };
            return githubFetch(
              `/repos/${owner}/${repo}/commits/${params.ref}/check-runs`,
              token,
            );
          }

          case "merge_pr": {
            if (!owner || !repo)
              return { error: "owner and repo are required for merge_pr." };
            if (params.prNumber == null)
              return { error: "prNumber is required for merge_pr." };
            return githubFetch(
              `/repos/${owner}/${repo}/pulls/${params.prNumber}/merge`,
              token,
              {
                method: "PUT",
                body: JSON.stringify({
                  merge_method: params.method ?? "merge",
                }),
              },
            );
          }

          case "list_branches": {
            if (!owner || !repo)
              return { error: "owner and repo are required for list_branches." };
            return githubFetch(
              `/repos/${owner}/${repo}/branches?per_page=30`,
              token,
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
      skillId: "github_ops",
      instructions:
        "You can interact with GitHub using the `github_ops` tool. Supported operations: list_repos, get_repo, list_issues, create_issue, list_prs, get_pr, search_code, create_pr, list_checks, merge_pr, list_branches. Provide the operation, owner, repo, and other fields as needed. For create_pr: provide head, base (default: main), title, and body. For merge_pr: provide prNumber and optional method (merge/squash/rebase). For list_checks: provide ref (branch or SHA).",
    };
  },
};

export default githubOpsSkill;
