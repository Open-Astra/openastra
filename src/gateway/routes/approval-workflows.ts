import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  createWorkflow,
  getWorkflows,
  getWorkflow,
  deleteWorkflow,
  submitForApproval,
  reviewStep,
  getApprovalRequest,
  getPendingApprovals,
} from "../../agents/approval-workflow.js";

// ── Approval Workflows Router ────────────────────────────────────────

const StepSchema = z.object({
  role: z.enum(["drafter", "reviewer", "approver"]),
  agentId: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
});

const CreateWorkflowBody = z.object({
  name: z.string().min(1).max(256),
  steps: z.array(StepSchema).min(1),
});

const SubmitBody = z.object({
  content: z.string().min(1),
});

const ReviewBody = z.object({
  stepId: z.string().min(1),
  approved: z.boolean(),
  feedback: z.string().optional(),
});

export function createApprovalWorkflowsRouter(): Router {
  const router = Router();

  // GET /approval-workflows — list workflows
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const wfs = getWorkflows(workspaceId);
    res.json(wfs);
  });

  // POST /approval-workflows — create workflow
  router.post("/", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = CreateWorkflowBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const wf = createWorkflow(workspaceId, parsed.data.name, parsed.data.steps, uid);
    res.status(201).json(wf);
  });

  // DELETE /approval-workflows/:id — delete
  router.delete("/:id", (req: Request, res: Response) => {
    const wf = getWorkflow(String(req.params.id));
    if (!wf) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const workspace = (req as WorkspaceAwareRequest).workspace;
    if (wf.workspaceId !== workspace?.workspaceId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    deleteWorkflow(String(req.params.id));
    res.status(204).end();
  });

  // POST /approval-workflows/:id/submit — submit content for approval
  router.post("/:id/submit", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const parsed = SubmitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const request = submitForApproval(String(req.params.id), workspaceId, parsed.data.content);
      res.status(201).json(request);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // POST /approval-requests/:id/review — review a step
  router.post("/:id/review", (req: Request, res: Response) => {
    const parsed = ReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const result = reviewStep(String(req.params.id), parsed.data.stepId, parsed.data.approved, parsed.data.feedback);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // GET /approval-requests — list pending requests (mounted separately)
  // We'll handle this on the same router since it's mounted at /approval-workflows
  // but add a sub-path

  return router;
}

// Separate router for approval-requests
export function createApprovalRequestsRouter(): Router {
  const router = Router();

  // GET /approval-requests — list pending requests
  router.get("/", (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const agentId = req.query.agentId as string | undefined;
    const pending = getPendingApprovals(workspaceId, agentId);
    res.json(pending);
  });

  // GET /approval-requests/:id — get single request
  router.get("/:id", (req: Request, res: Response) => {
    const request = getApprovalRequest(String(req.params.id));
    if (!request) {
      res.status(404).json({ error: "Approval request not found" });
      return;
    }
    res.json(request);
  });

  // POST /approval-requests/:id/review — review a step
  router.post("/:id/review", (req: Request, res: Response) => {
    const parsed = ReviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const result = reviewStep(String(req.params.id), parsed.data.stepId, parsed.data.approved, parsed.data.feedback);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  return router;
}
