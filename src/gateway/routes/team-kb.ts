import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  addEntry, searchEntries, getEntries, getEntry, updateEntry,
  deleteEntry, upvoteEntry, pruneStaleEntries,
} from "../../agents/team-kb.js";

const EntryBody = z.object({
  teamId: z.string().optional(),
  agentId: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
});

const SearchBody = z.object({
  query: z.string(),
  teamId: z.string().optional(),
  limit: z.number().int().optional(),
});

export function createTeamKbRouter(): Router {
  const router = Router();

  router.post("/team-kb/entries", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = EntryBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const entry = await addEntry(workspaceId, parsed.data);
    res.status(201).json(entry);
  });

  router.get("/team-kb/entries", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const teamId = req.query["teamId"] ? String(req.query["teamId"]) : undefined;
    res.json({ entries: await getEntries(workspaceId, teamId) });
  });

  router.get("/team-kb/entries/:id", async (req, res) => {
    const entry = await getEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    res.json(entry);
  });

  router.put("/team-kb/entries/:id", async (req, res) => {
    await updateEntry(req.params.id, req.body);
    res.json({ updated: true });
  });

  router.delete("/team-kb/entries/:id", async (req, res) => {
    await deleteEntry(req.params.id);
    res.json({ deleted: true });
  });

  router.post("/team-kb/search", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const results = await searchEntries(workspaceId, parsed.data.query, parsed.data);
    res.json({ results });
  });

  router.post("/team-kb/entries/:id/upvote", async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    await upvoteEntry(req.params.id, agentId);
    res.json({ upvoted: true });
  });

  router.post("/team-kb/prune", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const olderThanDays = parseInt(String(req.body.olderThanDays ?? "30"), 10);
    const pruned = await pruneStaleEntries(workspaceId, olderThanDays);
    res.json({ pruned });
  });

  return router;
}
