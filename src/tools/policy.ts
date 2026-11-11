import { AsyncLocalStorage } from "node:async_hooks";

// ── Tool Policy Helpers ─────────────────────────────────────────────
// Single place where tool names are normalised and where the *effective*
// policy of the currently executing call chain is tracked.
//
// Tools are registered with a mix of hyphenated and underscored names
// ("file-write" and "file_write" both exist). Policy written by operators
// (astra.yml allow/deny lists, risk catalog) must not silently miss because
// of that difference, so every policy comparison goes through
// normalizeToolName().

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export function normalizeToolSet(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) out.add(normalizeToolName(n));
  return out;
}

/** True when `name` (or its hyphen/underscore twin) is in `set`. */
export function toolSetHas(set: ReadonlySet<string> | undefined, name: string): boolean {
  if (!set || set.size === 0) return false;
  if (set.has(name)) return true;
  const norm = normalizeToolName(name);
  if (set.has(norm)) return true;
  for (const entry of set) {
    if (normalizeToolName(entry) === norm) return true;
  }
  return false;
}

// ── Execution Policy Context ────────────────────────────────────────
// Every executeTool() call runs the tool inside an AsyncLocalStorage scope
// carrying the caller's effective allow/deny sets. Any nested tool
// execution (delegate_tool_call, run_workflow, run_procedure, a spawned
// sub-agent's own loop, ...) is intersected with that scope, so a tool that
// runs other tools can never reach something its caller could not call
// directly. Deny always wins and accumulates down the chain.

export interface ExecutionPolicy {
  /** Normalised names the current call chain may execute. */
  allow: Set<string>;
  /** Normalised names denied anywhere up the call chain. */
  deny: Set<string>;
  /** Spawn depth of the agent currently running (0 = top-level agent). */
  spawnDepth: number;
  /** Workspace of the top-level request, carried through spawns. */
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<ExecutionPolicy>();

export function getExecutionPolicy(): ExecutionPolicy | undefined {
  return storage.getStore();
}

export function runWithExecutionPolicy<T>(policy: ExecutionPolicy, fn: () => T): T {
  return storage.run(policy, fn);
}

/**
 * Check `name` against a requested allow set AND the ambient call-chain
 * policy. Returns an error string when blocked, otherwise null.
 */
export function checkToolPolicy(name: string, requestedAllow: ReadonlySet<string>): string | null {
  if (!toolSetHas(requestedAllow, name)) return `Tool not allowed: ${name}`;
  const ambient = storage.getStore();
  if (ambient) {
    if (toolSetHas(ambient.deny, name)) return `Tool denied by policy: ${name}`;
    if (!toolSetHas(ambient.allow, name)) {
      return `Tool not allowed: ${name} (outside the calling agent's tool policy)`;
    }
  }
  return null;
}

/**
 * Build the policy scope for a tool about to execute: the requested allow
 * set narrowed by whatever the surrounding chain already permits.
 */
export function deriveExecutionPolicy(
  requestedAllow: ReadonlySet<string>,
  extra?: { deny?: Iterable<string>; workspaceId?: string },
): ExecutionPolicy {
  const ambient = storage.getStore();
  const requested = normalizeToolSet(requestedAllow);
  const deny = new Set<string>(ambient?.deny ?? []);
  for (const d of extra?.deny ?? []) deny.add(normalizeToolName(d));

  const allow = new Set<string>();
  for (const n of requested) {
    if (deny.has(n)) continue;
    if (ambient && !ambient.allow.has(n)) continue;
    allow.add(n);
  }
  return {
    allow,
    deny,
    spawnDepth: ambient?.spawnDepth ?? 0,
    workspaceId: extra?.workspaceId ?? ambient?.workspaceId,
  };
}
