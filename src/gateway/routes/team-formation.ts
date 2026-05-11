import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { formTeam, getFormedTeams, getFormedTeam } from "../../agents/team-formation.js";

// ── Team Formation Router ────────────────────────────────────────────
// POST /teams/form    — form a team for a task
// GET  /teams         — list formed teams
// GET  /teams/:id     — get team details

const FormTeamBody = z.object({
  task: z.string().min(1).max(2000),
  maxMembers: z.number().int().min(1).max(8).optional(),
  requiredSkills: z.array(z.string()).optional(),
  preferredAgents: z.array(z.string()).optional(),
});

export function createTeamFormationRouter(): Router {
  const router = Router();

  // POST /teams/form — form a team
  router.post("/teams/form", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = FormTeamBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
      return;
    }

    try {
      const team = await formTeam(workspaceId, parsed.data.task, {
        maxMembers: parsed.data.maxMembers,
        requiredSkills: parsed.data.requiredSkills,
        preferredAgents: parsed.data.preferredAgents,
      });
      res.status(201).json({ team });
    } catch (err) {
      console.error("[team-formation] Form:", err);
      res.status(500).json({ error: "Failed to form team" });
    }
  });

  // GET /teams — list formed teams for workspace
  router.get("/teams", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const teams = getFormedTeams(workspaceId);
    res.json({ teams });
  });

  // GET /teams/:id — get team details
  router.get("/teams/:id", (req: Request, res: Response) => {
    const team = getFormedTeam(req.params.id as string);

    if (!team) {
      res.status(404).json({ error: "Team not found" });
      return;
    }

    res.json({ team });
  });

  return router;
}
