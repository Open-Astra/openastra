import { normalizeToolName } from "./policy.js";
import { createLogger } from "../utils/logger.js";

// ── Tool Approval Policy ────────────────────────────────────────────
// Decides which tools must pass the human approval gate before running.
//
// Sources, in order of precedence:
//   1. setToolApprovalPolicy()            — programmatic (gateway startup, tests)
//   2. TOOL_APPROVAL_REQUIRED env var     — comma-separated tool names
//   3. astra.yml `approval.requireApproval` / `approval.timeoutMs`
//   4. DEFAULT_REQUIRE_APPROVAL below
//
// Names are matched with hyphens/underscores treated as equivalent.
// Entries in `approval.autoApprove` are removed from the required set.

const log = createLogger("approval-policy");

// High-risk tools that gate by default when nothing is configured.
export const DEFAULT_REQUIRE_APPROVAL = [
  "shell_execute",
  "code_execute",
  "agent_spawn",
  "file_write",
  "file-write",
  "patch-apply",
  "sql-query",
  "database_query",
  "git_ops",
  "run_tests",
];

// Abstract actions used in astra.yml that expand to several concrete tools.
const ACTION_ALIASES: Record<string, string[]> = {
  external_api: ["http_request", "send_webhook", "graphql_query"],
  file_write: ["file_write", "patch_apply", "memory_export", "markdown_to_pdf"],
  send_message: ["email_send", "send_email", "gmail_send", "push_notify"],
  swarm_execute: ["swarm_execute", "code_review_swarm"],
  shell_execute: ["shell_execute", "code_execute"],
};

export interface ToolApprovalPolicy {
  required: Set<string>;   // normalised tool names
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

let policy: ToolApprovalPolicy | null = null;
let loading: Promise<ToolApprovalPolicy> | null = null;

function expand(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of names) {
    const n = normalizeToolName(String(raw));
    if (!n) continue;
    out.add(n);
    for (const alias of ACTION_ALIASES[n] ?? []) out.add(normalizeToolName(alias));
  }
  return out;
}

export function setToolApprovalPolicy(input: {
  requireApproval?: string[];
  autoApprove?: string[];
  timeoutMs?: number;
}): ToolApprovalPolicy {
  const required = expand(input.requireApproval ?? DEFAULT_REQUIRE_APPROVAL);
  for (const a of input.autoApprove ?? []) required.delete(normalizeToolName(a));
  policy = {
    required,
    timeoutMs: typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
  return policy;
}

export function resetToolApprovalPolicy(): void {
  policy = null;
  loading = null;
}

async function load(): Promise<ToolApprovalPolicy> {
  const envList = process.env.TOOL_APPROVAL_REQUIRED;
  if (envList !== undefined) {
    return setToolApprovalPolicy({
      requireApproval: envList.split(",").map((s) => s.trim()).filter(Boolean),
      timeoutMs: Number(process.env.TOOL_APPROVAL_TIMEOUT_MS) || undefined,
    });
  }
  try {
    const { loadAstraConfig } = await import("../config/yaml-loader.js");
    const cfg = (await loadAstraConfig()) as unknown as {
      approval?: { requireApproval?: unknown; autoApprove?: unknown; timeoutMs?: unknown };
    } | null;
    const a = cfg?.approval;
    if (a && Array.isArray(a.requireApproval)) {
      return setToolApprovalPolicy({
        requireApproval: a.requireApproval.map(String),
        autoApprove: Array.isArray(a.autoApprove) ? a.autoApprove.map(String) : [],
        timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs : undefined,
      });
    }
  } catch (err) {
    // Config unreadable — fall through to the secure default set.
    log.warn(`Could not load approval policy from astra.yml: ${(err as Error).message}`);
  }
  return setToolApprovalPolicy({});
}

export async function getToolApprovalPolicy(): Promise<ToolApprovalPolicy> {
  if (policy) return policy;
  if (!loading) loading = load();
  return loading;
}

/** True when `toolName` must be approved by a human before it executes. */
export async function toolRequiresApproval(toolName: string, declared?: boolean): Promise<boolean> {
  if (declared === true) return true;
  const p = await getToolApprovalPolicy();
  return p.required.has(normalizeToolName(toolName));
}
