import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "../events/index.js";

const log = createLogger("approval-gate");

export async function requestApproval(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { uid: string; agentId: string; sessionId: string; workspaceId?: string },
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  // Only auto-approve in standalone CLI mode — server mode always requires
  // human review regardless of workspace context to prevent header-omission bypass.
  if (process.env.ASTRA_STANDALONE) return true;

  const id = randomUUID();
  const pool = getPool();

  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;

  // user_id and action are NOT NULL in the base table (migration 013); uid /
  // tool_name / tool_args were added in 048. Populate both generations so the
  // row is visible to every approvals API. If the request cannot be recorded
  // nobody can approve it, so the tool call is rejected (fail closed).
  try {
    await pool.query(
      `INSERT INTO approval_requests
         (id, workspace_id, session_id, agent_id, user_id, uid, action, tool_name, tool_args, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $7, 'pending', NOW() + ($8::double precision / 1000) * INTERVAL '1 second')`,
      [id, ctx.workspaceId ?? null, ctx.sessionId, ctx.agentId, ctx.uid, toolName, JSON.stringify(args), timeoutMs],
    );
  } catch (err) {
    log.error(`Could not record approval request for tool=${toolName}: ${(err as Error).message}`);
    return false;
  }

  getEventBus().emit("approval.requested" as any, {
    approvalId: id,
    toolName,
    args,
    uid: ctx.uid,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    workspaceId: ctx.workspaceId,
    timestamp: Date.now(),
  });

  log.info(`Approval requested id=${id} tool=${toolName} uid=${ctx.uid}`);

  // Poll for approval (1 second interval)
  const timeout = Date.now() + timeoutMs;
  while (Date.now() < timeout) {
    await new Promise((r) => setTimeout(r, 1000));
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM approval_requests WHERE id = $1`,
      [id],
    );
    const status = result.rows[0]?.status;
    if (status === "approved") {
      getEventBus().emit("approval.resolved" as any, { approvalId: id, status: "approved", timestamp: Date.now() });
      return true;
    }
    if (status === "rejected" || status === "denied" || status === "expired") {
      getEventBus().emit("approval.resolved" as any, { approvalId: id, status: "rejected", timestamp: Date.now() });
      return false;
    }
  }

  // Timeout — mark as expired
  await pool.query(`UPDATE approval_requests SET status = 'expired' WHERE id = $1`, [id]);
  log.warn(`Approval request expired id=${id} tool=${toolName}`);
  return false;
}
