import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "../events/index.js";

const log = createLogger("approval-gate");

export async function requestApproval(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { uid: string; agentId: string; sessionId: string; workspaceId?: string },
): Promise<boolean> {
  // Only auto-approve in standalone CLI mode — server mode always requires
  // human review regardless of workspace context to prevent header-omission bypass.
  if (process.env.ASTRA_STANDALONE) return true;

  const id = randomUUID();
  const pool = getPool();

  await pool.query(
    `INSERT INTO approval_requests (id, workspace_id, session_id, agent_id, uid, tool_name, tool_args)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, ctx.workspaceId, ctx.sessionId, ctx.agentId, ctx.uid, toolName, JSON.stringify(args)],
  );

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

  // Poll for approval (30 second timeout, 1 second interval)
  const timeout = Date.now() + 30_000;
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
    if (status === "rejected") {
      getEventBus().emit("approval.resolved" as any, { approvalId: id, status: "rejected", timestamp: Date.now() });
      return false;
    }
  }

  // Timeout — mark as expired
  await pool.query(`UPDATE approval_requests SET status = 'expired' WHERE id = $1`, [id]);
  log.warn(`Approval request expired id=${id} tool=${toolName}`);
  return false;
}
