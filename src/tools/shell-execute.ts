import { z } from "zod";
import { exec } from "node:child_process";
import { registerTool } from "./registry.js";

// ── shell_execute Tool ──────────────────────────────────────────────
// Executes a shell command and returns stdout/stderr. Timeout-protected,
// output-capped, and hardened against command injection.

const ShellExecuteParams = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory (defaults to process cwd)"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(15_000)
    .describe("Timeout in milliseconds (default 15s, max 60s)"),
});

// ── Destructive Command Blocklist ──────────────────────────────────
// Commands that are too dangerous for agent use under any circumstances.

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\//, // rm -rf /
  /\brm\s+-rf\s+~/, // rm -rf ~
  /\brm\s+-rf\s+\$HOME\b/, // rm -rf $HOME
  /\brm\s+-rf\s+\*/, // rm -rf *
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+-9\s+1\b/,
  /\bchmod\s+777\s+\//,
  /\bchmod\s+-R\s+777\b/,
  /:\(\)\{ :\|:& \};:/, // fork bomb
  /\bsudo\s+rm\b/,
  /\bsudo\s+chmod\b/,
  /\bsudo\s+chown\b/,
  /\bcurl\b.*\|\s*\bsh\b/, // curl | sh
  /\bcurl\b.*\|\s*\bbash\b/, // curl | bash
  /\bwget\b.*\|\s*\bsh\b/, // wget | sh
  /\bwget\b.*\|\s*\bbash\b/, // wget | bash
];

// ── Shell Metacharacter Injection Protection ───────────────────────
// Detect injection attempts via shell metacharacters that chain commands
// or perform subshell execution. These are blocked when they appear in
// suspicious patterns that suggest injection rather than normal usage.

const INJECTION_PATTERNS = [
  /&&/, // block && command chaining
  /\|\|/, // block || command chaining
  /;/, // block all semicolon command chaining
  /\n/, // block newline command separation
  /\r/, // block carriage return injection
  /`[^`]*`/, // backtick subshell execution
  /\$\([^)]*\)/, // $() subshell execution
  /\|/, // block all pipe chaining (data exfiltration vector)
  />\s*\/etc\//, // write to /etc/
  />\s*\/root\//, // write to /root/
  />\s*\/var\//, // write to /var/
  />\s*~\/\.ssh/, // write to ~/.ssh
  />\s*~\/\.bash/, // write to ~/.bashrc etc
];

// ── Path Traversal Protection ──────────────────────────────────────
// Block attempts to access sensitive system paths.

const SENSITIVE_PATHS = [
  /\/etc\/shadow/,
  /\/etc\/passwd/,
  /\/etc\/sudoers/,
  /\.ssh\/id_/,
  /\.ssh\/authorized_keys/,
  /\.env\b(?!\.example)/, // .env but not .env.example
  /\.git\/config/,
  /\.npmrc/,
  /\.netrc/,
  /credentials\.json/,
  /service[_-]?account.*\.json/,
  /\.aws\/credentials/,
  /\.aws\/config/,
];

// ── Allowlist Mode ─────────────────────────────────────────────────
// Default to allowlist mode; set SHELL_ALLOWLIST_MODE=false to use
// blocklist only (not recommended). Only commands starting with an
// allowed prefix are permitted. Set SHELL_ALLOWED_PREFIXES to a
// comma-separated list to customize
// (e.g., "git,npm,node,ls,cat,grep,find,wc,sort,head,tail").

// Default to allowlist mode; set SHELL_ALLOWLIST_MODE=false to use blocklist only (not recommended)
const ALLOWLIST_MODE = process.env.SHELL_ALLOWLIST_MODE !== "false";

const DEFAULT_ALLOWED_PREFIXES = [
  "git", "npm", "npx", "node", "tsx", "tsc",
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "diff",
  "grep", "rg", "find", "fd",
  "echo", "date", "pwd", "whoami", "uname", "hostname",
  "docker", "docker-compose",
  "jq", "yq", "sed", "awk",
  "python", "python3", "pip",
  "go", "cargo", "rustc",
  "make", "cmake",
  "psql",
  // Windows equivalents (cmd.exe built-ins)
  "dir", "type", "where", "findstr",
];

// Standalone CLI: tighter allowlist — no network tools, no interpreters,
// no container escape. Only read-only inspection + git + node toolchain.
const STANDALONE_ALLOWED_PREFIXES = [
  "git", "npm", "npx", "node", "tsx", "tsc",
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "diff",
  "grep", "rg", "find", "fd",
  "echo", "date", "pwd", "whoami", "uname", "hostname",
  "jq", "yq", "sed", "awk",
  // Windows equivalents (cmd.exe built-ins)
  "dir", "type", "where", "findstr",
];

function getAllowedPrefixes(): string[] {
  const custom = process.env.SHELL_ALLOWED_PREFIXES;
  if (custom) {
    return custom.split(",").map((p) => p.trim()).filter(Boolean);
  }
  return process.env.ASTRA_STANDALONE ? STANDALONE_ALLOWED_PREFIXES : DEFAULT_ALLOWED_PREFIXES;
}

function getFirstCommand(command: string): string {
  // Strip leading env vars (KEY=VALUE), whitespace, and get the base command
  const stripped = command.replace(/^(\s*\w+=\S+\s+)*/, "").trim();
  // Extract the first word (the command name)
  const match = stripped.match(/^(\S+)/);
  if (!match) return "";
  // Handle paths like /usr/bin/git → git
  const cmd = match[1]!;
  return cmd.includes("/") ? cmd.split("/").pop()! : cmd;
}

const MAX_OUTPUT = 50_000; // 50KB output cap

registerTool({
  name: "shell_execute",
  description:
    "Execute a shell command and return stdout/stderr. Use for running scripts, checking system state, processing data with CLI tools, git operations, etc. Commands are timeout-protected (default 15s). Dangerous commands and injection patterns are blocked.",
  parameters: ShellExecuteParams,
  async execute(params, ctx) {
    const command = params.command;

    // ── cwd restriction via agent fileAccess config ────────────────
    // If the agent has fileAccess.restricted, lock shell cwd to allowedPaths.
    // This reuses the same config that file_read/file_write/pdf_read check.
    // IMPORTANT: always enforce — not just when params.cwd is explicitly set.
    let effectiveCwd = params.cwd;
    if (ctx) {
      try {
        const { resolve: resolvePath, sep } = await import("node:path");
        const { getAgentConfig } = await import("../config/agents.js");
        const agentConfig = ctx.agentId ? getAgentConfig(ctx.agentId) : null;
        if (agentConfig?.fileAccess?.restricted) {
          const paths = agentConfig.fileAccess.allowedPaths;
          if (paths.length === 0) {
            return { error: `Shell cwd denied. Agent "${ctx.agentId}" has no allowed paths configured.` };
          }
          const resolvedAllowed = paths.map((p) => resolvePath(p));

          if (params.cwd) {
            // Validate explicit cwd against allowed paths
            const requested = resolvePath(params.cwd);
            const isAllowed = resolvedAllowed.some((p) => requested === p || requested.startsWith(p + sep));
            if (!isAllowed) {
              return { error: `Shell cwd restricted. Agent "${ctx.agentId}" can only operate in: ${paths.join(", ")}` };
            }
          } else {
            // No cwd provided — force to first allowed path (workspace root)
            effectiveCwd = resolvedAllowed[0];
          }

          // Scan command for absolute path arguments outside the workspace
          // Match Windows (C:\...) and Unix (/...) absolute paths in the command
          const pathPattern = /(?:[A-Za-z]:[\\\/][^\s"'|&;]+|\/(?!dev\/null)[^\s"'|&;]+)/g;
          let pathMatch: RegExpExecArray | null;
          while ((pathMatch = pathPattern.exec(command)) !== null) {
            const cmdPath = resolvePath(pathMatch[0]);
            const pathAllowed = resolvedAllowed.some((p) => cmdPath === p || cmdPath.startsWith(p + sep));
            if (!pathAllowed) {
              return {
                error: `Command references path outside workspace: "${pathMatch[0]}". ` +
                  `Agent "${ctx.agentId}" can only access: ${paths.join(", ")}`,
              };
            }
          }

          // Block .. traversal in commands when workspace-restricted
          if (/\.\.[\\/]/.test(command)) {
            // Resolve the .. relative to the effective cwd and check
            const testCwd = effectiveCwd ?? resolvePath(".");
            // Extract relative paths with .. and resolve them
            const relPattern = /(?:^|\s)(\.\.[\\/][^\s"'|&;]*)/g;
            let relMatch: RegExpExecArray | null;
            while ((relMatch = relPattern.exec(command)) !== null) {
              const resolved = resolvePath(testCwd, relMatch[1]!);
              const traversalAllowed = resolvedAllowed.some((p) => resolved === p || resolved.startsWith(p + sep));
              if (!traversalAllowed) {
                return {
                  error: `Command contains path traversal outside workspace. ` +
                    `Agent "${ctx.agentId}" can only access: ${paths.join(", ")}`,
                };
              }
            }
          }
        }
      } catch { /* config lookup failure — allow through */ }
    }

    // ── Allowlist mode ───────────────────────────────────────────
    if (ALLOWLIST_MODE) {
      const firstCmd = getFirstCommand(command);
      const allowed = getAllowedPrefixes();
      if (!allowed.includes(firstCmd)) {
        return {
          error: `Command "${firstCmd}" is not in the allowlist. ` +
            `Allowed commands: ${allowed.join(", ")}. ` +
            `Set SHELL_ALLOWED_PREFIXES to customize.`,
        };
      }
    }

    // ── Destructive command blocklist ─────────────────────────────
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return { error: "This command is blocked for safety reasons." };
      }
    }

    // ── Injection pattern detection ──────────────────────────────
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(command)) {
        return {
          error: "Command contains a potentially unsafe pattern (shell injection). " +
            "Avoid backtick subshells, $() expansion, or piping to interpreters.",
        };
      }
    }

    // ── Sensitive path access ────────────────────────────────────
    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.test(command)) {
        return {
          error: "Command references a sensitive file path. " +
            "Access to credentials, SSH keys, and system auth files is blocked.",
        };
      }
    }

    return new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd: effectiveCwd,
          timeout: params.timeoutMs,
          maxBuffer: MAX_OUTPUT * 2,
          env: { ...process.env, TERM: "dumb" },
        },
        (error, stdout, stderr) => {
          const truncateMsg = (s: string) =>
            s.length > MAX_OUTPUT
              ? s.slice(0, MAX_OUTPUT) + "\n... [truncated]"
              : s;

          if (error) {
            resolve({
              exitCode: error.code ?? 1,
              stdout: truncateMsg(stdout || ""),
              stderr: truncateMsg(stderr || error.message),
              killed: error.killed ?? false,
            });
          } else {
            resolve({
              exitCode: 0,
              stdout: truncateMsg(stdout || ""),
              stderr: truncateMsg(stderr || ""),
              killed: false,
            });
          }
        },
      );

      // Safety: ensure child is killed on timeout
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, params.timeoutMs + 1000);
    });
  },
});

export const _testOnly = { BLOCKED_PATTERNS, INJECTION_PATTERNS, SENSITIVE_PATHS, getFirstCommand, getAllowedPrefixes };
