// ── Tool Risk Classification ─────────────────────────────────────────
// Categorizes tools by risk level for role-based access control.
// Roles map to allowed risk levels:
//   owner → all levels
//   editor → SAFE, HIGH_RISK
//   tool_runner → SAFE, READ_ONLY
//   viewer → READ_ONLY

export type ToolRiskLevel = "READ_ONLY" | "SAFE" | "HIGH_RISK" | "ADMIN_ONLY";

export type Role = "owner" | "editor" | "tool_runner" | "viewer";

const ROLE_RISK_LEVELS: Record<Role, Set<ToolRiskLevel>> = {
  owner: new Set(["READ_ONLY", "SAFE", "HIGH_RISK", "ADMIN_ONLY"]),
  editor: new Set(["READ_ONLY", "SAFE", "HIGH_RISK"]),
  tool_runner: new Set(["SAFE", "READ_ONLY"]),
  viewer: new Set(["READ_ONLY"]),
};

export function canRoleExecuteTool(role: Role, toolRisk: ToolRiskLevel): boolean {
  return ROLE_RISK_LEVELS[role]?.has(toolRisk) ?? false;
}

// ── Tool Catalog ──────────────────────────────────────────────────────

export const TOOL_RISK_CATALOG: Record<string, ToolRiskLevel> = {
  // Read-only tools (safe for viewers)
  "memory-search": "READ_ONLY",
  "web-search": "READ_ONLY",
  "rag-search": "READ_ONLY",
  "memory-export": "READ_ONLY",
  "url-fetch": "READ_ONLY",
  "file-read": "HIGH_RISK",
  "file-fetch": "HIGH_RISK",
  "file-list": "HIGH_RISK",
  "pdf-read": "READ_ONLY",
  "graph-query": "READ_ONLY",
  "database-query": "HIGH_RISK",
  "graphql-query": "READ_ONLY",
  "sql-query": "HIGH_RISK",
  "http-request": "SAFE",
  "codebase-search": "READ_ONLY",
  "codebase-index": "READ_ONLY",
  "research-manage": "READ_ONLY",

  // Safe tools (tool_runner and above)
  "memory-write": "SAFE",
  "knowledge-ingest": "SAFE",
  "knowledge-delete": "SAFE",
  "email-send": "SAFE",
  "push-notify": "SAFE",
  "send-webhook": "SAFE",
  "calendar-event": "SAFE",
  "screenshot": "SAFE",
  "image-generate": "SAFE",
  "clipboard": "SAFE",
  "multi-modal-input": "SAFE",
  "model-inference": "SAFE",
  "approval-resolve": "ADMIN_ONLY",

  // High-risk tools (editor and owner only)
  "code-execute": "HIGH_RISK",
  "shell-execute": "HIGH_RISK",
  "file-write": "HIGH_RISK",
  "patch-apply": "HIGH_RISK",
  "agent-spawn": "HIGH_RISK",
  "debate-witnesses": "HIGH_RISK",
  "code-review-swarm": "HIGH_RISK",
  "meta-controller": "HIGH_RISK",
  "run-workflow": "HIGH_RISK",
  "run-procedure": "HIGH_RISK",
  "workspace-memory": "HIGH_RISK",
  "workspace-knowledge": "HIGH_RISK",
  "delegate-tool-call": "HIGH_RISK",
  "run-parallel-steps": "HIGH_RISK",
  "run-tests": "HIGH_RISK",
  "git-ops": "HIGH_RISK",
  "browser": "HIGH_RISK",
  "memory-import": "HIGH_RISK",

  // Admin-only tools (owner only)
  "hot-reload": "ADMIN_ONLY",
};

// Tools are registered with a mix of hyphens and underscores, so the catalog
// is looked up by a normalised name ("file_read" === "file-read").
const normalizeRiskKey = (name: string): string => name.trim().toLowerCase().replace(/-/g, "_");

const NORMALIZED_RISK_CATALOG = new Map<string, ToolRiskLevel>(
  Object.entries(TOOL_RISK_CATALOG).map(([name, level]) => [normalizeRiskKey(name), level]),
);

export function getToolRiskLevel(toolName: string): ToolRiskLevel {
  return NORMALIZED_RISK_CATALOG.get(normalizeRiskKey(toolName)) ?? "HIGH_RISK"; // default to HIGH_RISK if unknown
}
