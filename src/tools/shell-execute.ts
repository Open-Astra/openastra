import { z } from "zod";
import { exec, spawn } from "node:child_process";
import { registerTool } from "./registry.js";
import { decideExecution, minimalChildEnv, containerRunFlags, isStandaloneMode } from "./exec-sandbox.js";
import { loadEnv } from "../config/env.js";

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

// ── Argument-Level Escapes ─────────────────────────────────────────
// Allowlisting the first word is not enough: several "read-only" tools can
// run arbitrary programs or write files through their arguments. These are
// rejected regardless of mode. (They are defence in depth — in server mode
// the command additionally runs inside the container sandbox.)

const ARGUMENT_ESCAPE_PATTERNS: RegExp[] = [
  /^\s*\w+=\S*\s+\S/,                             // leading VAR=value (PATH / LD_PRELOAD / GIT_* tricks)
  /\$\{|\$[A-Za-z_]/,                             // variable expansion (awk-style $1 numerics stay allowed)
  /(^|[\s/"'=])\.[\w.\-]*[?*\[]/,                  // globbed dotfiles: .en?  .e*  .[e]nv
  /[?*\[][\w.\-?*\[\]]*(env|ssh|aws|npmrc|netrc|pem|key)\b/i, // globs that end in a secret-ish name
  /<\(|>\(/,                                      // process substitution
  /(^|\s)(node|npx|tsx|deno|bun|python3?|pip3?|sh|bash|zsh|perl|ruby|php)\s+(-e|-c|-p|--eval|--print)\b/, // inline interpreters
  /--(upload-pack|receive-pack|exec|exec-batch|exec-path|ext-diff|textconv)\b/,
  /\bext::/,                                      // git ext:: transport
];

// Options that are only dangerous for a specific command (grep -i / grep -o /
// grep -x are fine; sed -i, sort -o and fd -x are not).
const PER_COMMAND_ESCAPES: Record<string, RegExp[]> = {
  find: [/(^|\s)-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b/],
  fd: [/(^|\s)(-x|-X)\b/],
  awk: [/\bsystem\s*\(/, /\bgetline\b/, /\bprint\w*\b[^|>]*[|>]/, /(^|\s)(-f|--file|-i|--include|-l|--load)\b/],
  sed: [
    /(^|\s)(-i\S*|--in-place\S*)(\s|$)/,          // in-place writes
    /(^|\s)(-f|--file)\b/,                         // script files
    /(^|[\s;{'"])[0-9,$]*[ewrW]\s+\S/,             // e (exec) / w (write) / r (read) commands
    /\/[a-zA-Z0-9]*[ew][a-zA-Z0-9]*\s*(['"]|\s|;|$)/, // s///e and s///w flags
  ],
  sort: [/(^|\s)(-o\S*|--output\S*)(\s|$)/, /--compress-program/],
  git: [
    /(^|\s)-c(\s|\S+=)/, /--config-env\b/,         // per-invocation config (core.pager, alias.x=!cmd)
    /(^|\s)git\s+(config|daemon|filter-branch|bisect\s+run|submodule\s+foreach|difftool|mergetool)\b/,
    /\bcore\.(pager|editor|sshCommand|fsmonitor|hooksPath)\b/i,
    /(^|\s)(-o\S*|--output\S*|--output-directory\S*)(\s|=|$)/,
    /(^|\s)(-C|--git-dir|--work-tree)(\s|=)/,
  ],
  jq: [/(^|\s)(-f|--from-file|-L)\b/],
  yq: [/(^|\s)(-i|--inplace)\b/],
  rg: [/--pre\b/],
};

// Output redirection writes files (source dirs, plugin dirs, dotfiles).
// Only stderr-to-stdout and /dev/null sinks are tolerated.
function hasFileRedirect(command: string): boolean {
  const withoutSafe = command
    .replace(/\d?>&\d/g, "")
    .replace(/&?\d?>>?\s*\/dev\/null/g, "");
  return />/.test(withoutSafe);
}

/** Returns a human-readable reason when the command is refused, else null. */
function validateCommand(command: string, allowlistMode: boolean): string | null {
  if (allowlistMode) {
    const firstCmd = getFirstCommand(command);
    const allowed = getAllowedPrefixes();
    if (!allowed.includes(firstCmd)) {
      return `Command "${firstCmd}" is not in the allowlist. ` +
        `Allowed commands: ${allowed.join(", ")}. ` +
        `Set SHELL_ALLOWED_PREFIXES to customize.`;
    }
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return "This command is blocked for safety reasons.";
  }
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      return "Command contains a potentially unsafe pattern (shell injection). " +
        "Avoid backtick subshells, $() expansion, or piping to interpreters.";
    }
  }
  const perCommand = PER_COMMAND_ESCAPES[getFirstCommand(command)] ?? [];
  for (const pattern of [...ARGUMENT_ESCAPE_PATTERNS, ...perCommand]) {
    if (pattern.test(command)) {
      return "Command uses an option that can execute programs, expand variables or write files " +
        "(e.g. find -exec, awk system(), sed -i, git -c, VAR=value prefixes, globbed dotfiles).";
    }
  }
  if (hasFileRedirect(command)) {
    return "Output redirection to files is not allowed. Use the file tools to write files.";
  }
  for (const pattern of SENSITIVE_PATHS) {
    if (pattern.test(command)) {
      return "Command references a sensitive file path. " +
        "Access to credentials, SSH keys, and system auth files is blocked.";
    }
  }
  return null;
}

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
  /\/proc\/(self|\d+)\/(environ|cmdline|mem)/,
  /\.astra\/config\.json/,
  /\.docker\/config\.json/,
  /\.kube\/config/,
  /\.pgpass/,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/,
  /\.(pem|key|p12|pfx)\b/,
];

// ── Allowlist Mode ─────────────────────────────────────────────────
// Default to allowlist mode; set SHELL_ALLOWLIST_MODE=false to use
// blocklist only (not recommended). Only commands starting with an
// allowed prefix are permitted. Set SHELL_ALLOWED_PREFIXES to a
// comma-separated list to customize
// (e.g., "git,npm,node,ls,cat,grep,find,wc,sort,head,tail").

// Default to allowlist mode; set SHELL_ALLOWLIST_MODE=false to use blocklist only (not recommended)
const ALLOWLIST_MODE = process.env.SHELL_ALLOWLIST_MODE !== "false";

// Server default: read-only inspection + git. No interpreters (node, python,
// npx, tsx), no build drivers (make, npm, cargo, go), no docker, no psql —
// each of those is arbitrary code execution or a way out of the sandbox.
// Operators who need more can set SHELL_ALLOWED_PREFIXES explicitly.
const DEFAULT_ALLOWED_PREFIXES = [
  "git",
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "diff",
  "grep", "rg", "find", "fd",
  "echo", "date", "pwd", "whoami", "uname", "hostname",
  "jq", "yq", "sed", "awk",
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
    "Execute a single allowlisted shell command and return stdout/stderr. Read-only inspection and git only: no chaining, pipes, redirection, interpreters or variable expansion. In server mode this runs inside an isolated container and is disabled unless the operator enabled it.",
  parameters: ShellExecuteParams,
  async execute(params, ctx) {
    const command = params.command;

    // ── Execution gate ─────────────────────────────────────────────
    // Server mode: refused unless the operator opted in AND the container
    // sandbox is configured. Regex filters below are not a sandbox.
    let sandboxMode: string | undefined;
    let dockerImage = "node:20-slim";
    let memoryLimitMb = 256;
    try {
      const env = loadEnv();
      sandboxMode = env.codeExecSandbox;
      dockerImage = env.codeExecDockerImage || dockerImage;
      memoryLimitMb = env.codeExecMemoryLimitMb || memoryLimitMb;
    } catch {
      sandboxMode = process.env.CODE_EXEC_SANDBOX;
    }
    const decision = decideExecution("shell_execute", sandboxMode);
    if (!decision.allowed) {
      return { error: decision.reason };
    }

    // ── cwd restriction via agent fileAccess config ────────────────
    // If the agent has fileAccess.restricted, lock shell cwd to allowedPaths.
    // This reuses the same config that file_read/file_write/pdf_read check.
    // Fails closed: if the agent config cannot be resolved, nothing runs.
    let effectiveCwd = params.cwd;
    let workspaceMount: string | undefined;
    {
      const { resolve: resolvePath, sep } = await import("node:path");
      let agentConfig: { fileAccess?: { restricted?: boolean; allowedPaths: string[] } } | null;
      try {
        const { getAgentConfig } = await import("../config/agents.js");
        agentConfig = getAgentConfig(ctx.agentId);
      } catch {
        return { error: `Shell execution denied: agent "${ctx?.agentId}" could not be resolved.` };
      }

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
        workspaceMount = effectiveCwd ? resolvePath(effectiveCwd) : resolvedAllowed[0];

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
        if (/\.\.([\\/]|\s|$)/.test(command)) {
          const testCwd = effectiveCwd ?? resolvePath(".");
          const relPattern = /(?:^|[\s"'=])((?:[^\s"'|&;]*[\\/])?\.\.(?:[\\/][^\s"'|&;]*)?)/g;
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
      } else if (!isStandaloneMode()) {
        // Server mode without a restricted workspace: the container gets no
        // host mount at all, and an explicit host cwd is meaningless.
        if (params.cwd) {
          return {
            error: `Shell cwd denied. Agent "${ctx.agentId}" has no fileAccess.allowedPaths; ` +
              "configure a restricted workspace to mount one into the sandbox.",
          };
        }
      }
    }

    // ── Command validation (allowlist, blocklists, argument escapes) ──
    // Server mode always uses the allowlist; the blocklist-only mode
    // (SHELL_ALLOWLIST_MODE=false) is honoured in the standalone CLI only.
    const validationError = validateCommand(command, ALLOWLIST_MODE || !isStandaloneMode());
    if (validationError) {
      return { error: validationError };
    }

    const truncateMsg = (s: string) =>
      s.length > MAX_OUTPUT
        ? s.slice(0, MAX_OUTPUT) + "\n... [truncated]"
        : s;

    // ── Container execution (server mode / CODE_EXEC_SANDBOX=docker) ──
    if (decision.container) {
      const dockerArgs = [
        ...containerRunFlags(memoryLimitMb),
        ...(workspaceMount ? ["-v", `${workspaceMount}:/workspace:ro`, "-w", "/workspace"] : ["-w", "/tmp"]),
        dockerImage,
        "sh", "-c", command,
      ];
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let killed = false;
        const child = spawn("docker", dockerArgs, {
          env: minimalChildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (c: Buffer) => { if (stdout.length < MAX_OUTPUT * 2) stdout += c.toString("utf8"); });
        child.stderr?.on("data", (c: Buffer) => { if (stderr.length < MAX_OUTPUT * 2) stderr += c.toString("utf8"); });
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
          setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000);
        }, params.timeoutMs);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout: truncateMsg(stdout), stderr: truncateMsg(stderr), killed, sandbox: "docker" });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ exitCode: 1, stdout: "", stderr: `docker error: ${err.message}`, killed: false, sandbox: "docker" });
        });
      });
    }

    // ── Host execution (standalone CLI only) ──────────────────────
    return new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd: effectiveCwd,
          timeout: params.timeoutMs,
          maxBuffer: MAX_OUTPUT * 2,
          // Never the parent environment: API keys and DB credentials must
          // not be readable by executed commands.
          env: minimalChildEnv(),
        },
        (error, stdout, stderr) => {
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
      }, params.timeoutMs + 1000).unref();
    });
  },
});

export const _testOnly = {
  BLOCKED_PATTERNS,
  INJECTION_PATTERNS,
  SENSITIVE_PATHS,
  ARGUMENT_ESCAPE_PATTERNS,
  getFirstCommand,
  getAllowedPrefixes,
  validateCommand,
  hasFileRedirect,
};
