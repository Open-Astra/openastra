import { Router } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import {
  addEntry, searchEntries, getEntries, getEntry, updateEntry,
  deleteEntry, upvoteEntry, pruneStaleEntries,
} from "../../agents/team-kb.js";
import { requireOwned } from "../middleware/ownership.js";

const EntryBody = z.object({
  teamId: z.string().optional(),
  agentId: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
});

const SearchBody = z.object({
  query: z.string().min(1).max(2000),
  teamId: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const UpdateEntryBody = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(100_000).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
}).strict();

const UpvoteBody = z.object({ agentId: z.string().min(1).max(128) });
const PruneBody = z.object({ olderThanDays: z.coerce.number().int().min(1).max(3650).default(30) });

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

  router.get("/team-kb/entries/:id", requireOwned("teamKbEntry"), async (req, res) => {
    const entry = await getEntry(req.params.id as string);
    if (!entry) return res.status(404).json({ error: "Entry not found" });
    res.json(entry);
  });

  router.put("/team-kb/entries/:id", requireOwned("teamKbEntry"), async (req, res) => {
    const parsed = UpdateEntryBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    await updateEntry(req.params.id as string, parsed.data);
    res.json({ updated: true });
  });

  router.delete("/team-kb/entries/:id", requireOwned("teamKbEntry"), async (req, res) => {
    await deleteEntry(req.params.id as string);
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

  router.post("/team-kb/entries/:id/upvote", requireOwned("teamKbEntry"), async (req, res) => {
    const body = UpvoteBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "agentId required" });
    await upvoteEntry(req.params.id as string, body.data.agentId);
    res.json({ upvoted: true });
  });

  router.post("/team-kb/prune", async (req, res) => {
    const workspaceId = (req as unknown as WorkspaceAwareRequest).workspace.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: "Workspace required" });
    const body = PruneBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.message });
    const pruned = await pruneStaleEntries(workspaceId, body.data.olderThanDays);
    res.json({ pruned });
  });

  return router;
}
