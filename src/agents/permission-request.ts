import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import type { ToolContext } from "../tools/types.js";

const log = createLogger("permission-request");

export async function requestToolPermission(
  toolNames: string[],
  reason: string,
  ctx: ToolContext,
): Promise<void> {
  if (!ctx.workspaceId) return;

  const id = randomUUID();
  await getPool().query(
    `INSERT INTO tool_permission_requests (id, workspace_id, agent_id, uid, requested_tools, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, ctx.workspaceId, ctx.agentId, ctx.uid, toolNames, reason],
  );

  getEventBus().emit("permission.requested" as any, {
    requestId: id, toolNames, reason, agentId: ctx.agentId,
    uid: ctx.uid, workspaceId: ctx.workspaceId, timestamp: Date.now(),
  });

  log.info(`Permission request created: ${id} for tools [${toolNames.join(", ")}]`);
}
