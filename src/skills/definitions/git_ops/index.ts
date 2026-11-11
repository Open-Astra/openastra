import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { guardPath } from "../../../tools/path-guard.js";
import { isStandaloneMode, minimalChildEnv } from "../../../tools/exec-sandbox.js";

// ── Git Operations Skill ────────────────────────────────────────────
// Git repository operations: status, diff, log, branch management.
// Operates on a configurable repo path (GIT_REPO_PATH or cwd).

const MAX_OUTPUT = 5000;

const StatusParams = z.object({
  repoPath: z.string().optional().describe("Repository path (default: GIT_REPO_PATH or cwd)"),
});

const LogParams = z.object({
  repoPath: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10).describe("Number of commits to show"),
  branch: z.string().optional().describe("Branch name (default: current)"),
});

const DiffParams = z.object({
  repoPath: z.string().optional(),
  staged: z.boolean().default(false).describe("Show staged changes only"),
  file: z.string().optional().describe("Specific file to diff"),
});

const BranchParams = z.object({
  repoPath: z.string().optional(),
  action: z.enum(["list", "current", "create"]).default("list"),
  name: z.string().optional().describe("Branch name (for create action)"),
});

const CommitParams = z.object({
  message: z.string().describe("Commit message"),
  files: z.array(z.string()).optional().describe("Specific files to stage and commit (default: all modified)"),
  repoPath: z.string().optional().describe("Repository path (default: GIT_REPO_PATH or cwd)"),
});

const CheckoutParams = z.object({
  branch: z.string().describe("Branch name to checkout"),
  create: z.boolean().optional().default(false).describe("Create a new branch"),
  repoPath: z.string().optional().describe("Repository path (default: GIT_REPO_PATH or cwd)"),
});

const PushParams = z.object({
  remote: z.string().optional().default("origin").describe("Remote name (default: origin)"),
  branch: z.string().optional().describe("Branch to push (default: HEAD)"),
  repoPath: z.string().optional().describe("Repository path (default: GIT_REPO_PATH or cwd)"),
});

const StashParams = z.object({
  action: z.enum(["push", "pop", "list"]).describe("Stash action"),
  message: z.string().optional().describe("Stash message (for push action)"),
  repoPath: z.string().optional().describe("Repository path (default: GIT_REPO_PATH or cwd)"),
});

// Hardening applied to every git invocation:
//   - hooks disabled (a repo's hooks are arbitrary code)
//   - ext:: / file-less transports off, no credential or terminal prompts
//   - minimal environment (no gateway secrets, no inherited GIT_* overrides)
const GIT_SAFE_FLAGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.ext.allow=never",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
];

function gitEnv(): Record<string, string> {
  return minimalChildEnv({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat" });
}

function gitExec(args: string[], cwd: string): string {
  try {
    return execFileSync("git", [...GIT_SAFE_FLAGS, ...args], { cwd, encoding: "utf-8", timeout: 10_000, env: gitEnv() })
      .trim()
      .slice(0, MAX_OUTPUT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: ${msg.slice(0, 500)}`;
  }
}

// ── Argument validation ─────────────────────────────────────────────
// Values that reach git's argv must never be interpretable as options
// (`--output=...`, `--upload-pack=...`, `-c ...`) or as transport URLs.

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/@^~{}-]{0,199}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function checkRef(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!REF_NAME.test(value) || value.includes("..")) return `Invalid ${label}: "${value.slice(0, 60)}"`;
  return null;
}

function checkRemote(value: string): string | null {
  // Must be the NAME of a configured remote — never a URL, path or option.
  return REMOTE_NAME.test(value) ? null : `Invalid remote name: "${value.slice(0, 60)}"`;
}

function checkPathspec(value: string, label: string): string | null {
  if (value.startsWith("-") || value.startsWith(":") || value.includes("\0")) {
    return `Invalid ${label}: "${value.slice(0, 60)}"`;
  }
  return null;
}

class GitRepoError extends Error {}

const gitOpsSkill: SkillDefinition = {
  name: "git_ops",
  version: "1.0.0",

  manifest: {
    id: "git_ops",
    name: "Git Operations",
    description: "Git repository operations: status, log, diff, branch management, commit, checkout, push, and stash.",
    category: "execute",
    tools: ["git_status", "git_log", "git_diff", "git_branch", "git_commit", "git_checkout", "git_push", "git_stash"],
    configFields: [
      { name: "repoPath", type: "string", required: false, description: "Default repository path", envVar: "GIT_REPO_PATH" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    // Resolve and validate the repository directory.
    //   - must be inside the operator-configured GIT_REPO_PATH (or cwd)
    //   - symlink-resolved; secret paths refused; agent fileAccess honoured
    //   - mutating operations in server mode require GIT_REPO_PATH, so an
    //     agent can never commit to / check out over the gateway's own tree
    const getRepo = (override: string | undefined, agentId: string | undefined, mutate = false): string => {
      const configured = process.env.GIT_REPO_PATH;
      if (mutate && !isStandaloneMode() && !configured) {
        throw new GitRepoError(
          "Write git operations are disabled in server mode unless the operator sets GIT_REPO_PATH.",
        );
      }
      const base = resolve(configured ?? process.cwd());
      try {
        return guardPath(override ?? base, { access: "list", agentId, baseDir: base });
      } catch (err) {
        throw new GitRepoError(err instanceof Error ? err.message : "Invalid repository path");
      }
    };

    ctx.registerTool({
      name: "git_status",
      description: "Show the working tree status of a git repository.",
      parameters: StatusParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, false);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }
        const status = gitExec(["status", "--short"], cwd);
        const branch = gitExec(["branch", "--show-current"], cwd);

        // For ahead/behind, handle the case where upstream doesn't exist
        let ahead = 0;
        let behind = 0;
        try {
          const aheadStr = execFileSync("git", [...GIT_SAFE_FLAGS, "rev-list", "--count", "@{upstream}..HEAD"], { cwd, encoding: "utf-8", timeout: 10_000, env: gitEnv() }).trim();
          ahead = parseInt(aheadStr, 10) || 0;
        } catch { /* no upstream */ }
        try {
          const behindStr = execFileSync("git", [...GIT_SAFE_FLAGS, "rev-list", "--count", "HEAD..@{upstream}"], { cwd, encoding: "utf-8", timeout: 10_000, env: gitEnv() }).trim();
          behind = parseInt(behindStr, 10) || 0;
        } catch { /* no upstream */ }

        const lines = status.split("\n").filter((l) => l.trim());
        return {
          branch,
          modified: lines.filter((l) => l.startsWith(" M") || l.startsWith("M")).length,
          added: lines.filter((l) => l.startsWith("A") || l.startsWith("??")).length,
          deleted: lines.filter((l) => l.startsWith(" D") || l.startsWith("D")).length,
          ahead,
          behind,
          files: lines.map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })),
        };
      },
    });

    ctx.registerTool({
      name: "git_log",
      description: "Show recent git commit history.",
      parameters: LogParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, false);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }
        const refError = checkRef(params.branch, "branch");
        if (refError) return { error: refError };
        const args = ["log", "--oneline", "--format=%H|%h|%s|%an|%ar", `-${params.limit}`];
        if (params.branch) args.push("--end-of-options", params.branch, "--");
        const log = gitExec(args, cwd);

        const commits = log.split("\n").filter((l) => l.includes("|")).map((line) => {
          const [hash, short, message, author, date] = line.split("|");
          return { hash, short, message, author, date };
        });

        return { branch: params.branch ?? "HEAD", count: commits.length, commits };
      },
    });

    ctx.registerTool({
      name: "git_diff",
      description: "Show git diff (staged or unstaged changes).",
      parameters: DiffParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, false);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }

        if (params.file) {
          const fileError = checkPathspec(params.file, "file");
          if (fileError) return { error: fileError };
        }
        const diffArgs: string[] = ["diff", "--no-ext-diff", "--no-textconv"];
        if (params.staged) diffArgs.push("--cached");
        if (params.file) diffArgs.push("--", params.file);

        const statArgs: string[] = ["diff", "--no-ext-diff", "--no-textconv"];
        if (params.staged) statArgs.push("--cached");
        statArgs.push("--stat");
        if (params.file) statArgs.push("--", params.file);

        const diff = gitExec(diffArgs, cwd);
        const stat = gitExec(statArgs, cwd);

        return { staged: params.staged, stat, diff: diff.slice(0, MAX_OUTPUT) };
      },
    });

    ctx.registerTool({
      name: "git_branch",
      description: "List branches, show current branch, or create a new branch.",
      parameters: BranchParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, params.action === "create");
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }

        switch (params.action) {
          case "current":
            return { branch: gitExec(["branch", "--show-current"], cwd) };
          case "list": {
            const branches = gitExec(["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(committerdate:relative)"], cwd);
            return {
              branches: branches.split("\n").filter((l) => l.includes("|")).map((l) => {
                const [name, hash, date] = l.split("|");
                return { name, hash, date };
              }),
            };
          }
          case "create": {
            if (!params.name) return { error: "Branch name required for create action." };
            const nameError = checkRef(params.name, "branch name");
            if (nameError) return { error: nameError };
            const result = gitExec(["branch", "--end-of-options", params.name], cwd);
            return result.startsWith("ERROR") ? { error: result } : { success: true, created: params.name };
          }
        }
      },
    });

    ctx.registerTool({
      name: "git_commit",
      description: "Stage files and create a git commit.",
      parameters: CommitParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, true);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }

        if (params.files && params.files.length > 0) {
          // Stage specific files then commit
          for (const f of params.files) {
            const fileError = checkPathspec(f, "file");
            if (fileError) return { error: fileError };
          }
          const addResult = gitExec(["add", "--", ...params.files], cwd);
          if (addResult.startsWith("ERROR")) return { error: addResult };
          const commitResult = gitExec(["commit", "-m", params.message], cwd);
          return commitResult.startsWith("ERROR")
            ? { error: commitResult }
            : { success: true, message: params.message, output: commitResult };
        } else {
          // Commit all modified tracked files
          const commitResult = gitExec(["commit", "-am", params.message], cwd);
          return commitResult.startsWith("ERROR")
            ? { error: commitResult }
            : { success: true, message: params.message, output: commitResult };
        }
      },
    });

    ctx.registerTool({
      name: "git_checkout",
      description: "Switch branches or create a new branch.",
      parameters: CheckoutParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, true);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }
        const refError = checkRef(params.branch, "branch");
        if (refError) return { error: refError };
        const args: string[] = ["checkout"];
        if (params.create) args.push("-b");
        args.push("--end-of-options", params.branch);
        if (!params.create) args.push("--");
        const result = gitExec(args, cwd);
        return result.startsWith("ERROR")
          ? { error: result }
          : { success: true, branch: params.branch, created: params.create, output: result };
      },
    });

    ctx.registerTool({
      name: "git_push",
      description: "Push commits to a remote repository.",
      parameters: PushParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, true);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }
        const remote = params.remote ?? "origin";
        const branch = params.branch ?? "HEAD";
        const remoteError = checkRemote(remote);
        if (remoteError) return { error: remoteError };
        const refError = checkRef(branch, "branch");
        if (refError) return { error: refError };
        const result = gitExec(["push", "--end-of-options", remote, branch], cwd);
        return result.startsWith("ERROR")
          ? { error: result }
          : { success: true, remote, branch, output: result };
      },
    });

    ctx.registerTool({
      name: "git_stash",
      description: "Stash or restore uncommitted changes.",
      parameters: StashParams,

      async execute(params, toolCtx) {
        let cwd: string;
        try {
          cwd = getRepo(params.repoPath, toolCtx?.agentId, true);
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Invalid repository path" };
        }

        switch (params.action) {
          case "push": {
            const msg = params.message ?? "auto";
            const result = gitExec(["stash", "push", "-m", msg], cwd);
            return result.startsWith("ERROR")
              ? { error: result }
              : { success: true, action: "push", output: result };
          }
          case "pop": {
            const result = gitExec(["stash", "pop"], cwd);
            return result.startsWith("ERROR")
              ? { error: result }
              : { success: true, action: "pop", output: result };
          }
          case "list": {
            const result = gitExec(["stash", "list"], cwd);
            const stashes = result
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => l.trim());
            return { action: "list", stashes, count: stashes.length };
          }
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "git_ops",
      instructions: "You can interact with git repos using `git_status` (working tree status), `git_log` (commit history), `git_diff` (show changes), `git_branch` (list/create branches), `git_commit` (stage and commit), `git_checkout` (switch/create branches), `git_push` (push to remote), and `git_stash` (stash/restore changes).",
    };
  },
};

export default gitOpsSkill;
