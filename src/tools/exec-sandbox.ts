// ── Host Execution Gate ─────────────────────────────────────────────
// Shared by code_execute and shell_execute.
//
// Pattern blocklists are NOT a sandbox: `require("child_" + "process")`,
// `find -exec`, `awk 'BEGIN{system()}'` and friends walk straight through
// them. The only real isolation available here is the container sandbox
// (CODE_EXEC_SANDBOX=docker: no network, read-only rootfs, dropped caps).
//
//   Standalone CLI (ASTRA_STANDALONE set)
//     The person at the keyboard is the operator and the only tenant, so
//     execution is allowed on the host with a minimal environment.
//
//   Server mode (gateway, multi-tenant)
//     Refused unless the operator BOTH
//       - opts in:  ASTRA_ENABLE_CODE_EXEC=true / ASTRA_ENABLE_SHELL_EXEC=true
//       - and configures the container sandbox: CODE_EXEC_SANDBOX=docker
//     in which case the command runs inside the container, never on the host.

export type ExecTool = "code_execute" | "shell_execute";

export interface ExecDecision {
  allowed: boolean;
  /** Run inside the container sandbox rather than on the host. */
  container: boolean;
  reason?: string;
}

export function isStandaloneMode(): boolean {
  return Boolean(process.env.ASTRA_STANDALONE);
}

const OPT_IN_ENV: Record<ExecTool, string> = {
  code_execute: "ASTRA_ENABLE_CODE_EXEC",
  shell_execute: "ASTRA_ENABLE_SHELL_EXEC",
};

export function decideExecution(tool: ExecTool, sandboxMode: string | undefined): ExecDecision {
  const container = sandboxMode === "docker";

  if (isStandaloneMode()) {
    return { allowed: true, container };
  }

  const flag = OPT_IN_ENV[tool];
  if (process.env[flag] !== "true") {
    return {
      allowed: false,
      container,
      reason:
        `${tool} is disabled in server mode. An operator must set ${flag}=true ` +
        `and CODE_EXEC_SANDBOX=docker to enable it.`,
    };
  }
  if (!container) {
    return {
      allowed: false,
      container,
      reason:
        `${tool} requires the container sandbox in server mode ` +
        `(CODE_EXEC_SANDBOX=docker). Host execution is not permitted.`,
    };
  }
  return { allowed: true, container: true };
}

/**
 * Environment handed to child processes. Never process.env: provider keys,
 * JWT secrets and database passwords must not be visible to executed code.
 */
export function minimalChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
  };
  for (const key of ["HOME", "USER", "TMPDIR", "TZ", "SystemRoot", "ComSpec", "PATHEXT"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return { ...env, ...extra };
}

/** Hardened `docker run` flags shared by every sandboxed execution. */
export function containerRunFlags(memoryLimitMb: number): string[] {
  return [
    "run", "--rm", "--network=none",
    `--memory=${memoryLimitMb}m`, "--memory-swap=0",
    "--cpus=0.5", "--read-only",
    "--tmpfs=/tmp:size=64m,noexec",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=50",
    "--ulimit", "nproc=50:50",
    "--ulimit", "fsize=1048576:1048576",
    "--user", "65534:65534",
  ];
}
