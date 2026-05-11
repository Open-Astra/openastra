import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  assignRole,
  getTeamMembers,
  removeFromTeam,
  getTeamMembership,
  type TeamRole,
} from "../../agents/team-roles.js";

const AssignRoleBody = z.object({
  agentId: z.string().min(1),
  role: z.enum(["lead", "specialist", "reviewer", "executor", "observer"]),
});

export function createTeamRolesRouter(): Router {
  const router = Router();

  // GET /team-roles — list team members + roles
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const members = getTeamMembers(workspaceId);
    res.json({ members });
  });

  // POST /team-roles — assign role
  router.post("/", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = AssignRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const membership = assignRole(workspaceId, parsed.data.agentId, parsed.data.role as TeamRole, uid);
    res.status(201).json(membership);
  });

  // DELETE /team-roles/:agentId — remove from team
  router.delete("/:agentId", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    removeFromTeam(workspaceId, req.params.agentId as string);
    res.status(204).end();
  });

  // GET /team-roles/:agentId/permissions — check permissions
  router.get("/:agentId/permissions", (req: Request, res: Response) => {
    const workspace = (req as unknown as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const membership = getTeamMembership(workspaceId, req.params.agentId as string);
    if (!membership) {
      res.status(404).json({ error: "Agent not in team" });
      return;
    }

    res.json({ agentId: membership.agentId, role: membership.role, permissions: membership.permissions });
  });

  return router;
}
