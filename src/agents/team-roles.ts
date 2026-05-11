import { createLogger } from "../utils/logger.js";

const log = createLogger("team-roles");

// ── Types ────────────────────────────────────────────────────────────

export type TeamRole = "lead" | "specialist" | "reviewer" | "executor" | "observer";

export interface TeamMembership {
  agentId: string;
  workspaceId: string;
  role: TeamRole;
  permissions: TeamPermissions;
  assignedBy: string;
  assignedAt: number;
}

export interface TeamPermissions {
  canDelegate: boolean;
  canApproveTools: boolean;
  canInterrupt: boolean;
  canAccessAllMemory: boolean;
  maxToolCostUsd: number; // 0 = no limit
  allowedToolPatterns: string[]; // glob patterns, empty = all allowed
}

// ── In-Memory Store ──────────────────────────────────────────────────
// Keyed by `${workspaceId}:${agentId}`

const teamMembers = new Map<string, TeamMembership>();

function storeKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

// ── Default Permissions by Role ──────────────────────────────────────

const ROLE_DEFAULTS: Record<TeamRole, TeamPermissions> = {
  lead: {
    canDelegate: true,
    canApproveTools: true,
    canInterrupt: true,
    canAccessAllMemory: true,
    maxToolCostUsd: 0,
    allowedToolPatterns: [],
  },
  specialist: {
    canDelegate: false,
    canApproveTools: false,
    canInterrupt: false,
    canAccessAllMemory: true,
    maxToolCostUsd: 0,
    allowedToolPatterns: [],
  },
  reviewer: {
    canDelegate: false,
    canApproveTools: true,
    canInterrupt: true,
    canAccessAllMemory: true,
    maxToolCostUsd: 0,
    allowedToolPatterns: [],
  },
  executor: {
    canDelegate: false,
    canApproveTools: false,
    canInterrupt: false,
    canAccessAllMemory: false,
    maxToolCostUsd: 1.0,
    allowedToolPatterns: [],
  },
  observer: {
    canDelegate: false,
    canApproveTools: false,
    canInterrupt: false,
    canAccessAllMemory: false,
    maxToolCostUsd: 0,
    allowedToolPatterns: [],
  },
};

// ── Public API ───────────────────────────────────────────────────────

export function getDefaultPermissions(role: TeamRole): TeamPermissions {
  return { ...ROLE_DEFAULTS[role], allowedToolPatterns: [...ROLE_DEFAULTS[role].allowedToolPatterns] };
}

export function assignRole(
  workspaceId: string,
  agentId: string,
  role: TeamRole,
  assignedBy: string,
): TeamMembership {
  const membership: TeamMembership = {
    agentId,
    workspaceId,
    role,
    permissions: getDefaultPermissions(role),
    assignedBy,
    assignedAt: Date.now(),
  };

  teamMembers.set(storeKey(workspaceId, agentId), membership);
  log.info(`Assigned role "${role}" to agent ${agentId} in workspace ${workspaceId}`);
  return membership;
}

export function getTeamMembership(workspaceId: string, agentId: string): TeamMembership | null {
  return teamMembers.get(storeKey(workspaceId, agentId)) ?? null;
}

export function getTeamMembers(workspaceId: string): TeamMembership[] {
  const result: TeamMembership[] = [];
  for (const membership of teamMembers.values()) {
    if (membership.workspaceId === workspaceId) {
      result.push(membership);
    }
  }
  return result;
}

export function removeFromTeam(workspaceId: string, agentId: string): void {
  const k = storeKey(workspaceId, agentId);
  const existed = teamMembers.delete(k);
  if (existed) {
    log.info(`Removed agent ${agentId} from team in workspace ${workspaceId}`);
  }
}

export function checkPermission(
  workspaceId: string,
  agentId: string,
  action: keyof TeamPermissions,
): boolean {
  const membership = teamMembers.get(storeKey(workspaceId, agentId));
  if (!membership) return false;

  const value = membership.permissions[action];
  if (typeof value === "boolean") return value;
  // For numeric fields (maxToolCostUsd), truthy = has some budget or unlimited
  if (typeof value === "number") return value !== 0 || action === "maxToolCostUsd";
  // For array fields (allowedToolPatterns), empty = all allowed = true
  if (Array.isArray(value)) return true;
  return false;
}
