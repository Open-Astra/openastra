import { Router } from "express";
import { z } from "zod";
import {
  appendEntry,
  verifyChain,
  getEntries,
  getLedgerStats,
  listCheckpoints,
} from "../../observability/audit-ledger.js";
import type { LedgerEntryType } from "../../observability/audit-ledger.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const AppendBody = z.object({
  entryType: z.enum([
    "agent.decision", "tool.call", "tool.result",
    "memory.write", "memory.delete", "config.change",
    "auth.login", "auth.logout", "security.violation",
  ]),
  payload: z.record(z.string(), z.unknown()),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

const VerifyQuery = z.object({
  fromSeq: z.coerce.number().int().optional(),
  toSeq: z.coerce.number().int().optional(),
});

export function createAuditLedgerRouter(): Router {
  const router = Router();

  // GET /stats — ledger statistics
  router.get("/stats", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const stats = await getLedgerStats(workspaceId);
      return res.json(stats);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /entries — query ledger entries
  router.get("/entries", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const entries = await getEntries(workspaceId, {
        entryType: req.query["type"] as LedgerEntryType | undefined,
        agentId: req.query["agentId"] as string | undefined,
        sessionId: req.query["sessionId"] as string | undefined,
        fromSeq: req.query["fromSeq"] ? Number(req.query["fromSeq"]) : undefined,
        limit: req.query["limit"] ? Number(req.query["limit"]) : 100,
      });
      return res.json(entries);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /entries — append a new entry (for external integrations)
  router.post("/entries", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const parsed = AppendBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const entry = await appendEntry(workspaceId, parsed.data.entryType, parsed.data.payload, {
        agentId: parsed.data.agentId,
        sessionId: parsed.data.sessionId,
        uid,
      });
      return res.status(201).json(entry);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /verify — verify hash chain integrity
  router.post("/verify", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = VerifyQuery.safeParse(req.query);
      const result = await verifyChain(
        workspaceId,
        parsed.success ? parsed.data.fromSeq : undefined,
        parsed.success ? parsed.data.toSeq : undefined,
      );
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /checkpoints — list Merkle checkpoints
  router.get("/checkpoints", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const checkpoints = await listCheckpoints(workspaceId);
      return res.json(checkpoints);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
