import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── GitHub PR Review Skill ─────────────────────────────────────────
// Specialized skill for pull request review workflows.
// Provides a comprehensive code review checklist and PR review guidelines
// in the system prompt. Registers get-github-pr and post-pr-comment tools.
// The list-pr-files tool is provided as a lightweight stub here.

import { z } from "zod";

const ListPrFilesParams = z.object({
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  prNumber: z.number().int().positive().describe("Pull request number"),
  token: z.string().optional().describe("GitHub personal access token"),
});

const githubPrSkill: SkillDefinition = {
  name: "github_pr",
  version: "1.0.0",

  manifest: {
    id: "github_pr",
    name: "GitHub PR Review",
    description:
      "Specialized skill for pull request code review. Provides PR details, file listing, " +
      "and comment posting tools with a structured review checklist injected into the system prompt.",
    category: "analyze",
    tools: ["get-github-pr", "list-pr-files", "post-pr-comment"],
    configFields: [
      {
        name: "token",
        type: "string",
        required: false,
        description: "GitHub personal access token for private repos",
        envVar: "GITHUB_TOKEN",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    // get-github-pr and post-pr-comment are registered via src/tools/index.ts.
    // Register list-pr-files here as it is skill-specific.
    ctx.registerTool({
      name: "list-pr-files",
      description:
        "Lists all files changed in a GitHub pull request. " +
        "Returns filename, status (added/modified/removed/renamed), additions, deletions, " +
        "and a short patch snippet. " +
        "Params: owner, repo, prNumber, token (optional GitHub PAT).",
      parameters: ListPrFilesParams,
      async execute(params) {
        const { owner, repo, prNumber, token } = params;

        if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
          return { error: "Invalid owner or repo name." };
        }

        const { isBlockedUrl } = await import("../../../utils/ssrf-guard.js");
        const filesUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;

        if (await isBlockedUrl(filesUrl)) {
          return { error: "SSRF guard blocked the GitHub API URL." };
        }

        const headers: Record<string, string> = {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "astra-platform/1.0",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        try {
          const response = await fetch(filesUrl, { headers });

          if (!response.ok) {
            return { error: `GitHub API returned ${response.status}: ${response.statusText}` };
          }

          const files = await response.json() as Array<Record<string, unknown>>;

          return {
            prNumber,
            totalFiles: files.length,
            files: files.map((f) => ({
              filename: f["filename"] as string,
              status: f["status"] as string,
              additions: f["additions"] as number,
              deletions: f["deletions"] as number,
              changes: f["changes"] as number,
              patch: ((f["patch"] as string) ?? "").slice(0, 1000),
              blobUrl: (f["blob_url"] as string) ?? "",
            })),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Failed to list PR files: ${msg}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "github_pr",
      instructions: [
        "## GitHub PR Review Guidelines",
        "",
        "You are conducting a thorough code review. Use these tools:",
        "- **get-github-pr**: Fetch PR title, description, state, and metadata",
        "- **list-pr-files**: List all changed files with diffs",
        "- **post-pr-comment**: Post your review summary as a comment",
        "",
        "### Review Checklist",
        "",
        "**Correctness**",
        "- [ ] Does the code do what the PR description says?",
        "- [ ] Are edge cases handled (null, empty, overflow)?",
        "- [ ] Are error paths handled and logged appropriately?",
        "",
        "**Security**",
        "- [ ] No hardcoded secrets or credentials",
        "- [ ] Input validation present for user-supplied data",
        "- [ ] SQL queries use parameterized statements",
        "- [ ] No path traversal vulnerabilities",
        "",
        "**Performance**",
        "- [ ] No N+1 queries or unnecessary database calls",
        "- [ ] Large loops or allocations justified",
        "",
        "**Maintainability**",
        "- [ ] Functions are small and focused (single responsibility)",
        "- [ ] Variable and function names are descriptive",
        "- [ ] Complex logic has inline comments",
        "- [ ] No dead code or commented-out blocks",
        "",
        "**Tests**",
        "- [ ] New logic has corresponding test coverage",
        "- [ ] Existing tests still pass (no regressions introduced)",
        "",
        "### Review Format",
        "Structure your review as:",
        "1. Summary (1-2 sentences: what the PR does)",
        "2. Verdict: APPROVE / REQUEST_CHANGES / COMMENT",
        "3. Issues found (if any), grouped by severity: Critical > Major > Minor > Nit",
        "4. Positive observations",
        "",
        "Be specific: reference file names and line ranges where possible.",
        "Be constructive: suggest fixes, not just problems.",
      ].join("\n"),
    };
  },
};

export default githubPrSkill;
