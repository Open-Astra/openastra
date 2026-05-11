import { Router } from "express";
import { z } from "zod";
import {
  createContract,
  getContract,
  listContracts,
  updateContract,
  deleteContract,
  enforceContracts,
  listViolations,
} from "../../memory/contracts.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  maxRetentionDays: z.number().int().positive().optional(),
  minRetentionDays: z.number().int().positive().optional(),
  maxRecallMs: z.number().int().positive().optional(),
  dataResidencyRegion: z.string().optional(),
  archivePolicy: z.enum(["cold_store", "delete", "compress"]).optional(),
  tierRestrictions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  enforce: z.boolean().optional(),
});

const UpdateBody = CreateBody.partial().omit({ name: true });

export function createMemoryContractsRouter(): Router {
  const router = Router();

  // GET / — list all contracts for workspace
  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const contracts = await listContracts(workspaceId);
      return res.json(contracts);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /:id — get a single contract
  router.get("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const contract = await getContract(req.params.id!, workspaceId);
      if (!contract) return res.status(404).json({ error: "not found" });
      return res.json(contract);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST / — create a contract
  router.post("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const uid = (req as unknown as AuthenticatedRequest).uid;

      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const contract = await createContract(workspaceId, parsed.data.name, parsed.data, uid);
      return res.status(201).json(contract);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /:id — update a contract
  router.patch("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const parsed = UpdateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const contract = await updateContract(req.params.id!, workspaceId, parsed.data);
      if (!contract) return res.status(404).json({ error: "not found" });
      return res.json(contract);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /:id — delete a contract
  router.delete("/:id", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const deleted = await deleteContract(req.params.id!, workspaceId);
      if (!deleted) return res.status(404).json({ error: "not found" });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // POST /enforce — run enforcement for all contracts in workspace
  router.post("/enforce", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const violations = await enforceContracts(workspaceId);
      return res.json({ enforced: true, violations });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // GET /violations — list violations
  router.get("/violations/all", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });
      const contractId = req.query["contractId"] as string | undefined;
      const limit = req.query["limit"] ? Number(req.query["limit"]) : 50;
      const violations = await listViolations(workspaceId, contractId, limit);
      return res.json(violations);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
