import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { getPool } from "../../config/postgres.js";

const UpsertPolicyBody = z.object({
  allowedRegions: z.array(z.string()),
  allowedProviders: z.array(z.string()),
});

export function createDataPoliciesRouter(): Router {
  const router = Router();

  // GET / — get data policy for workspace
  router.get("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const result = await getPool().query<{
        workspace_id: string;
        allowed_regions: string[];
        allowed_providers: string[];
        updated_at: string;
      }>(
        `SELECT workspace_id, allowed_regions, allowed_providers, updated_at
         FROM workspace_data_policies WHERE workspace_id = $1`,
        [workspaceId],
      );

      if (result.rows.length === 0) {
        res.json({});
        return;
      }

      const row = result.rows[0]!;
      res.json({
        workspaceId: row.workspace_id,
        allowedRegions: row.allowed_regions,
        allowedProviders: row.allowed_providers,
        updatedAt: row.updated_at,
      });
    } catch (err) {
      console.error("[data-policies] GET:", err);
      res.status(500).json({ error: "Failed to get data policy" });
    }
  });

  // PUT / — upsert data policy for workspace
  router.put("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = UpsertPolicyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { allowedRegions, allowedProviders } = parsed.data;

    try {
      await getPool().query(
        `INSERT INTO workspace_data_policies (workspace_id, allowed_regions, allowed_providers, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (workspace_id) DO UPDATE
           SET allowed_regions = EXCLUDED.allowed_regions,
               allowed_providers = EXCLUDED.allowed_providers,
               updated_at = NOW()`,
        [workspaceId, allowedRegions, allowedProviders],
      );

      res.json({ workspaceId, allowedRegions, allowedProviders });
    } catch (err) {
      console.error("[data-policies] PUT:", err);
      res.status(500).json({ error: "Failed to upsert data policy" });
    }
  });

  return router;
}
