import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { logAgentAction } from "./audit.js";

// ── Human-in-the-Loop Approval Workflows ────────────────────────────
// Sensitive actions (spawning agents, writing memory, financial ops,
// shell execution, external API calls) can require explicit user
// approval before proceeding. The agent pauses, emits an approval
// request event, and resumes only when the user responds.
//
// Approval flow:
//   1. Agent requests approval → persisted in DB, event emitted
//   2. Gateway pushes approval request to user (WS/Telegram/etc.)
//   3. User approves or denies via channel or API
//   4. Agent resumes or aborts based on decision
//
// Policies are defined per-agent in AgentConfig or globally.

// ── Types ───────────────────────────────────────────────────────────

export type ApprovalAction =
  | "agent_spawn"
  | "memory_write"
  | "memory_delete"
  | "shell_execute"
  | "file_write"
  | "external_api"
  | "financial_action"
  | "graph_write"
  | "send_message"
  | "swarm_execute";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "auto_approved";

export interface ApprovalRequest {
  id: string;
  uid: string;
  agentId: string;
  sessionId: string;
  action: ApprovalAction;
  description: string;           // human-readable description of what's being requested
  details: Record<string, unknown>; // action-specific metadata (tool args, target agent, etc.)
  status: ApprovalStatus;
  expiresAt: number;             // auto-expire after timeout
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;           // "user" | "auto" | "timeout"
  reason?: string;               // user-provided reason for denial
}

export interface ApprovalPolicy {
  requireApproval: ApprovalAction[]; // actions that need approval
  autoApprove: ApprovalAction[];     // actions auto-approved (logged only)
  timeoutMs: number;                 // how long to wait before expiring (default: 5 min)
  defaultOnTimeout: "deny" | "approve"; // what to do if user doesn't respond
}

// ── Default Policy ──────────────────────────────────────────────────

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  requireApproval: ["shell_execute", "financial_action", "agent_spawn"],
  autoApprove: ["memory_write", "memory_delete"],
  timeoutMs: 300_000, // 5 minutes
  defaultOnTimeout: "deny",
};

// ── Pending Request Map ─────────────────────────────────────────────
// In-memory map of pending approval requests. Resolvers are called
// when user responds.

const pendingResolvers = new Map<string, {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// ── Request Approval ────────────────────────────────────────────────

/**
 * Request approval for a sensitive action. Returns a promise that
 * resolves when the user approves/denies or the timeout expires.
 */
export async function requestApproval(
  uid: string,
  agentId: string,
  sessionId: string,
  action: ApprovalAction,
  description: string,
  details: Record<string, unknown> = {},
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): Promise<{ approved: boolean; requestId: string }> {
  const requestId = randomUUID();

  // Check if auto-approved
  if (policy.autoApprove.includes(action)) {
    await persistApproval({
      id: requestId,
      uid,
      agentId,
      sessionId,
      action,
      description,
      details,
      status: "auto_approved",
      expiresAt: Date.now(),
      createdAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: "auto",
    });
    return { approved: true, requestId };
  }

  // Check if approval required
  if (!policy.requireApproval.includes(action)) {
    // Not in require list and not in auto-approve → allow by default
    return { approved: true, requestId };
  }

  const request: ApprovalRequest = {
    id: requestId,
    uid,
    agentId,
    sessionId,
    action,
    description,
    details,
    status: "pending",
    expiresAt: Date.now() + policy.timeoutMs,
    createdAt: Date.now(),
  };

  // Persist and emit event
  await persistApproval(request);

  const bus = getEventBus();
  bus.emit("approval.requested" as any, {
    requestId,
    uid,
    agentId,
    sessionId,
    action,
    description,
    details,
    expiresAt: request.expiresAt,
    timestamp: Date.now(),
  });

  await logAgentAction(uid, agentId, "approval_requested" as any, {
    requestId,
    action,
    description,
  });

  console.log(`[approval] Requesting approval: ${action} — ${description} (${requestId.slice(0, 8)})`);

  // Wait for resolution
  return new Promise<{ approved: boolean; requestId: string }>((resolve) => {
    const timer = setTimeout(() => {
      // Timeout — apply default policy
      pendingResolvers.delete(requestId);
      const approved = policy.defaultOnTimeout === "approve";
      resolveApproval(requestId, approved ? "approved" : "expired", "timeout").catch(() => {});
      resolve({ approved, requestId });
    }, policy.timeoutMs);

    pendingResolvers.set(requestId, {
      resolve: (approved) => {
        clearTimeout(timer);
        pendingResolvers.delete(requestId);
        resolve({ approved, requestId });
      },
      timer,
    });
  });
}

// ── Resolve Approval ────────────────────────────────────────────────

/**
 * Called when user approves or denies a pending request.
 */
export async function resolveApproval(
  requestId: string,
  status: "approved" | "denied" | "expired",
  resolvedBy: string = "user",
  reason?: string,
): Promise<boolean> {
  const pool = getPool();

  await pool.query(
    `UPDATE approval_requests
     SET status = $1, resolved_at = NOW(), resolved_by = $2, reason = $3
     WHERE id = $4 AND status = 'pending'`,
    [status, resolvedBy, reason ?? null, requestId],
  );

  const approved = status === "approved";

  // Notify the waiting agent
  const pending = pendingResolvers.get(requestId);
  if (pending) {
    pending.resolve(approved);
  }

  const bus = getEventBus();
  bus.emit("approval.resolved" as any, {
    requestId,
    status,
    resolvedBy,
    reason,
    timestamp: Date.now(),
  });

  console.log(`[approval] ${requestId.slice(0, 8)} → ${status} by ${resolvedBy}`);

  return approved;
}

// ── Query Approvals ─────────────────────────────────────────────────

export async function getPendingApprovals(uid: string): Promise<ApprovalRequest[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; config: ApprovalRequest }>(
    `SELECT id, config FROM approval_requests
     WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [uid],
  );
  return rows.map((r) => r.config);
}

export async function getApprovalHistory(
  uid: string,
  limit: number = 50,
): Promise<ApprovalRequest[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: ApprovalRequest }>(
    `SELECT config FROM approval_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [uid, limit],
  );
  return rows.map((r) => r.config);
}

// ── Middleware Helper ────────────────────────────────────────────────
// Can be used in the tool execution pipeline.

export function needsApproval(
  action: ApprovalAction,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): boolean {
  return policy.requireApproval.includes(action);
}

// ── Persistence ─────────────────────────────────────────────────────

async function persistApproval(request: ApprovalRequest): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO approval_requests (id, user_id, agent_id, session_id, action, status, config, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, to_timestamp($8::double precision / 1000), NOW())
     ON CONFLICT (id)
     DO UPDATE SET status = $6, config = $7::jsonb`,
    [
      request.id,
      request.uid,
      request.agentId,
      request.sessionId,
      request.action,
      request.status,
      JSON.stringify(request),
      request.expiresAt,
    ],
  );
}
