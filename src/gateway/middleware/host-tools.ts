// ── Host-Access Tools ───────────────────────────────────────────────
// Tools that reach the gateway host, its database, or arbitrary code.
// In a shared deployment a tenant must not be able to grant these to an
// agent (or invoke them through the tool playground) on their own say-so:
// that is code execution on the operator's machine. Granting them takes
// the platform admin key, or the operator opting the whole deployment in
// with ALLOW_TENANT_HOST_TOOLS=true (single-tenant / self-hosted installs).

export const normalizeToolId = (name: string): string =>
  name.trim().toLowerCase().replace(/-/g, "_");

export const HOST_ACCESS_TOOLS: ReadonlySet<string> = new Set(
  [
    "shell_execute", "code_execute", "file_read", "file_write", "file_fetch",
    "file_browser", "patch_apply", "database_query", "sql_query", "browser",
    "delegate_tool_call", "run_workflow", "run_parallel_steps",
    "run_procedure", "run_tests", "git_ops", "memory_export", "memory_import",
    "markdown_to_pdf", "codebase_index", "approval_resolve",
  ].map(normalizeToolId),
);

export function isHostAccessTool(name: string): boolean {
  return HOST_ACCESS_TOOLS.has(normalizeToolId(name));
}

/**
 * Host-access tools named in an allow list. Wildcards count: "*" would
 * grant everything.
 */
export function findHostAccessTools(toolNames: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const raw of toolNames) {
    if (raw.trim() === "*" || isHostAccessTool(raw)) hits.push(raw);
  }
  return hits;
}

export function tenantsMayGrantHostTools(): boolean {
  return process.env.ALLOW_TENANT_HOST_TOOLS === "true";
}
