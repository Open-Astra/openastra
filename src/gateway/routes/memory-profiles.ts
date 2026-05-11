// Mount: app.use("/memory-profiles", jwtAuth(), workspaceResolver(), createMemoryProfilesRouter()); in gateway/index.ts

import { Router } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  MemoryProfileConfigSchema,
  createMemoryProfile,
  listMemoryProfiles,
  getMemoryProfile,
  updateMemoryProfile,
  deleteMemoryProfile,
  assignAgentProfile,
  getAgentProfile,
} from "../../memory/profiles.js";

// ── Request Validation ──────────────────────────────────────────────

const CreateProfileBody = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).nullable().optional(),
  config: MemoryProfileConfigSchema.optional(),
});

const UpdateProfileBody = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(500).nullable().optional(),
  config: MemoryProfileConfigSchema.optional(),
});

const AssignProfileBody = z.object({
  profileId: z.string().min(1),
});

// ── Helper ───────────────────────────────────────────────────────────

function resolveWorkspaceId(req: WorkspaceAwareRequest & AuthenticatedRequest): string {
  return req.workspace.workspaceId ?? req.uid;
}

// ── Router ───────────────────────────────────────────────────────────

export function createMemoryProfilesRouter(): Router {
  const router = Router();

  // POST /memory-profiles — create a new memory profile
  router.post("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const parsed = CreateProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const workspaceId = resolveWorkspaceId(r);
    const { name, description = null, config } = parsed.data;

    try {
      const profile = await createMemoryProfile(
        workspaceId,
        name,
        description ?? null,
        config ?? MemoryProfileConfigSchema.parse({}),
      );
      res.status(201).json(profile);
    } catch (err) {
      console.error("[memory-profiles] Create error:", err);
      res.status(500).json({ error: "Failed to create memory profile" });
    }
  });

  // GET /memory-profiles — list all profiles for the workspace
  router.get("/", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const profiles = await listMemoryProfiles(workspaceId);
      res.json({ profiles });
    } catch (err) {
      console.error("[memory-profiles] List error:", err);
      res.status(500).json({ error: "Failed to list memory profiles" });
    }
  });

  // GET /memory-profiles/:id — get a single profile
  router.get("/:id", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const profile = await getMemoryProfile(req.params.id, workspaceId);
      if (!profile) {
        res.status(404).json({ error: "Memory profile not found" });
        return;
      }
      res.json(profile);
    } catch (err) {
      console.error("[memory-profiles] Get error:", err);
      res.status(500).json({ error: "Failed to get memory profile" });
    }
  });

  // PUT /memory-profiles/:id — update a profile
  router.put("/:id", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const parsed = UpdateProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const workspaceId = resolveWorkspaceId(r);

    try {
      const updated = await updateMemoryProfile(req.params.id, workspaceId, parsed.data);
      if (!updated) {
        res.status(404).json({ error: "Memory profile not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      console.error("[memory-profiles] Update error:", err);
      res.status(500).json({ error: "Failed to update memory profile" });
    }
  });

  // DELETE /memory-profiles/:id — delete a profile
  router.delete("/:id", async (req, res) => {
    const r = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const workspaceId = resolveWorkspaceId(r);

    try {
      const deleted = await deleteMemoryProfile(req.params.id, workspaceId);
      if (!deleted) {
        res.status(404).json({ error: "Memory profile not found" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      console.error("[memory-profiles] Delete error:", err);
      res.status(500).json({ error: "Failed to delete memory profile" });
    }
  });

  // PUT /agents/:agentId/memory-profile — assign a profile to an agent
  router.put("/agents/:agentId/memory-profile", async (req, res) => {
    const parsed = AssignProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const r2 = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const { agentId } = req.params;
    const { profileId } = parsed.data;
    const workspaceId = resolveWorkspaceId(r2);

    try {
      await assignAgentProfile(agentId, profileId, workspaceId);
      res.json({ agentId, profileId });
    } catch (err) {
      console.error("[memory-profiles] Assign error:", err);
      res.status(500).json({ error: "Failed to assign memory profile to agent" });
    }
  });

  // GET /agents/:agentId/memory-profile — get the current profile for an agent
  router.get("/agents/:agentId/memory-profile", async (req, res) => {
    const r3 = req as unknown as WorkspaceAwareRequest & AuthenticatedRequest;
    const { agentId } = req.params;
    const workspaceId = resolveWorkspaceId(r3);

    try {
      const profile = await getAgentProfile(agentId, workspaceId);
      if (!profile) {
        res.status(404).json({ error: "No memory profile assigned to this agent" });
        return;
      }
      res.json(profile);
    } catch (err) {
      console.error("[memory-profiles] Get agent profile error:", err);
      res.status(500).json({ error: "Failed to get agent memory profile" });
    }
  });

  return router;
}
