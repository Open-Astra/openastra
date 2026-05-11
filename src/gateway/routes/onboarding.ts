import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { AgentConfig } from "../../agents/types.js";
import { createAgentConfig } from "../../agents/config-store.js";
import { createWorkspace } from "../../workspaces/store.js";
import { listUserWorkspaces } from "../../workspaces/store.js";

// ── Request Validation ──────────────────────────────────────────────

const OnboardingBody = z.object({
  workspaceName: z.string().min(1).max(100).optional(),
  agents: z.array(AgentConfig).min(1).max(10),
});

// ── Onboarding Router ───────────────────────────────────────────────

export function createOnboardingRouter(): Router {
  const router = Router();

  // POST /onboarding/setup — create initial workspace + agents
  router.post("/setup", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;

    const parsed = OnboardingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { workspaceName, agents } = parsed.data;

    try {
      // Find or create the user's default workspace
      let workspaceId: string;
      const existingWorkspaces = await listUserWorkspaces(uid);

      if (existingWorkspaces.length > 0) {
        workspaceId = existingWorkspaces[0]!.workspaceId;
      } else {
        const workspace = await createWorkspace(
          uid,
          workspaceName ?? "My Workspace",
          "team",
        );
        workspaceId = workspace.id;
      }

      // Create each agent config
      const created: string[] = [];
      const errors: Array<{ agentId: string; error: string }> = [];

      for (const agentConfig of agents) {
        try {
          await createAgentConfig(agentConfig, workspaceId, uid);
          created.push(agentConfig.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ agentId: agentConfig.id, error: message });
        }
      }

      res.status(201).json({
        workspaceId,
        created,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err) {
      console.error("[onboarding] Setup error:", err);
      res.status(500).json({ error: "Onboarding failed" });
    }
  });

  return router;
}
