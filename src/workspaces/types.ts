import { z } from "zod";

export const WorkspaceRole = z.enum(["owner", "admin", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const WorkspacePlan = z.enum(["personal", "team", "enterprise"]);
export type WorkspacePlan = z.infer<typeof WorkspacePlan>;

export interface WorkspaceDoc {
  id: string;
  name: string;
  ownerId: string;
  plan: WorkspacePlan;
  createdAt: number;
  settings: {
    defaultAgentId?: string;
    customAgentConfigs?: Record<string, unknown>;
  };
}

export interface WorkspaceMember {
  uid: string;
  role: WorkspaceRole;
  joinedAt: number;
  invitedBy?: string;
}

export interface WorkspaceContext {
  workspaceId: string | null; // null = personal workspace
  role: WorkspaceRole;
}
