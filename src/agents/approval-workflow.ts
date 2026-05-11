import { randomUUID } from "node:crypto";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("approval-workflow");

// ── Types ────────────────────────────────────────────────────────────

export interface ApprovalWorkflow {
  id: string;
  workspaceId: string;
  name: string;
  steps: ApprovalStep[];
  createdBy: string;
  createdAt: number;
}

export interface ApprovalStep {
  id: string;
  role: "drafter" | "reviewer" | "approver";
  agentId: string;
  dependsOn?: string[];
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  workspaceId: string;
  content: string;
  currentStepId: string;
  status: "pending" | "in_review" | "approved" | "rejected";
  stepResults: Record<string, { status: string; feedback?: string; timestamp: number }>;
  createdAt: number;
}

// ── In-memory stores ─────────────────────────────────────────────────

const workflows = new Map<string, ApprovalWorkflow>();
const requests = new Map<string, ApprovalRequest>();

// ── Workflow CRUD ────────────────────────────────────────────────────

export function createWorkflow(
  workspaceId: string,
  name: string,
  steps: Omit<ApprovalStep, "id">[],
  createdBy: string,
): ApprovalWorkflow {
  const workflow: ApprovalWorkflow = {
    id: randomUUID(),
    workspaceId,
    name,
    steps: steps.map((s) => ({ ...s, id: randomUUID() })),
    createdBy,
    createdAt: Date.now(),
  };
  workflows.set(workflow.id, workflow);
  return workflow;
}

export function getWorkflows(workspaceId: string): ApprovalWorkflow[] {
  const result: ApprovalWorkflow[] = [];
  for (const w of workflows.values()) {
    if (w.workspaceId === workspaceId) result.push(w);
  }
  return result;
}

export function getWorkflow(workflowId: string): ApprovalWorkflow | null {
  return workflows.get(workflowId) ?? null;
}

export function deleteWorkflow(workflowId: string): void {
  workflows.delete(workflowId);
}

// ── Approval Requests ────────────────────────────────────────────────

export function submitForApproval(
  workflowId: string,
  workspaceId: string,
  content: string,
): ApprovalRequest {
  const workflow = workflows.get(workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  // Find the first step(s) with no dependencies — topological roots
  const firstStep = findNextStep(workflow.steps, {});
  if (!firstStep) throw new Error("No initial step found in workflow");

  const request: ApprovalRequest = {
    id: randomUUID(),
    workflowId,
    workspaceId,
    content,
    currentStepId: firstStep.id,
    status: "pending",
    stepResults: {},
    createdAt: Date.now(),
  };
  requests.set(request.id, request);

  try {
    const bus = getEventBus();
    bus.emit("approval.submitted" as never, {
      requestId: request.id,
      workflowId,
      workspaceId,
      stepId: firstStep.id,
      agentId: firstStep.agentId,
      timestamp: Date.now(),
    } as never);
  } catch {
    log.warn("Failed to emit approval.submitted event");
  }

  return request;
}

export function reviewStep(
  requestId: string,
  stepId: string,
  approved: boolean,
  feedback?: string,
): ApprovalRequest {
  const request = requests.get(requestId);
  if (!request) throw new Error(`Request not found: ${requestId}`);

  const workflow = workflows.get(request.workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${request.workflowId}`);

  // Record step result
  request.stepResults[stepId] = {
    status: approved ? "approved" : "rejected",
    feedback,
    timestamp: Date.now(),
  };

  try {
    const bus = getEventBus();
    bus.emit("approval.step_completed" as never, {
      requestId,
      stepId,
      approved,
      feedback,
      timestamp: Date.now(),
    } as never);
  } catch {
    log.warn("Failed to emit approval.step_completed event");
  }

  if (!approved) {
    request.status = "rejected";
    try {
      const bus = getEventBus();
      bus.emit("approval.rejected" as never, {
        requestId,
        workflowId: request.workflowId,
        workspaceId: request.workspaceId,
        stepId,
        feedback,
        timestamp: Date.now(),
      } as never);
    } catch {
      log.warn("Failed to emit approval.rejected event");
    }
    return request;
  }

  // Find next step
  const nextStep = findNextStep(workflow.steps, request.stepResults);
  if (nextStep) {
    request.currentStepId = nextStep.id;
    request.status = "in_review";
  } else {
    // All steps completed
    request.status = "approved";
    try {
      const bus = getEventBus();
      bus.emit("approval.completed" as never, {
        requestId,
        workflowId: request.workflowId,
        workspaceId: request.workspaceId,
        timestamp: Date.now(),
      } as never);
    } catch {
      log.warn("Failed to emit approval.completed event");
    }
  }

  return request;
}

export function getApprovalRequest(requestId: string): ApprovalRequest | null {
  return requests.get(requestId) ?? null;
}

export function getPendingApprovals(workspaceId: string, agentId?: string): ApprovalRequest[] {
  const result: ApprovalRequest[] = [];
  for (const r of requests.values()) {
    if (r.workspaceId !== workspaceId) continue;
    if (r.status === "approved" || r.status === "rejected") continue;

    if (agentId) {
      const workflow = workflows.get(r.workflowId);
      if (!workflow) continue;
      const currentStep = workflow.steps.find((s) => s.id === r.currentStepId);
      if (!currentStep || currentStep.agentId !== agentId) continue;
    }

    result.push(r);
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

function findNextStep(
  steps: ApprovalStep[],
  completedResults: Record<string, { status: string }>,
): ApprovalStep | null {
  const completedIds = new Set(
    Object.entries(completedResults)
      .filter(([, v]) => v.status === "approved")
      .map(([k]) => k),
  );

  for (const step of steps) {
    if (completedIds.has(step.id)) continue;
    if (completedResults[step.id]?.status === "rejected") continue;

    const deps = step.dependsOn ?? [];
    const allDepsMet = deps.every((d) => completedIds.has(d));
    if (allDepsMet) return step;
  }
  return null;
}
