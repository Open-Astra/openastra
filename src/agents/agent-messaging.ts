import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";

// ── Agent-to-Agent Messaging ─────────────────────────────────────────
// Persistent messaging between agents within a workspace.
// Messages are stored in PostgreSQL and surfaced via REST API.

export interface AgentMessage {
  id: string;
  workspaceId: string;
  fromAgentId: string;
  toAgentId: string;
  messageType: "text" | "request" | "response" | "notification";
  content: unknown;
  inReplyTo?: string;
  readAt?: string;
  createdAt: string;
}

function rowToMessage(row: Record<string, unknown>): AgentMessage {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    fromAgentId: row.from_agent_id as string,
    toAgentId: row.to_agent_id as string,
    messageType: row.message_type as AgentMessage["messageType"],
    content: row.content,
    inReplyTo: (row.in_reply_to as string) ?? undefined,
    readAt: row.read_at ? String(row.read_at) : undefined,
    createdAt: String(row.created_at),
  };
}

/** Send a message from one agent to another. */
export async function sendAgentMessage(
  workspaceId: string,
  fromAgentId: string,
  toAgentId: string,
  messageType: string,
  content: unknown,
  inReplyTo?: string,
): Promise<AgentMessage> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO agent_messages (workspace_id, from_agent_id, to_agent_id, message_type, content, in_reply_to)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [workspaceId, fromAgentId, toAgentId, messageType, JSON.stringify(content), inReplyTo ?? null],
  );

  const msg = rowToMessage(rows[0]);

  try {
    const bus = getEventBus();
    bus.emit("agent.message", {
      messageId: msg.id,
      fromAgentId,
      toAgentId,
      uid: fromAgentId,
      content: typeof content === "string" ? content : JSON.stringify(content),
      timestamp: Date.now(),
    });
  } catch {
    // event bus may not be ready
  }

  return msg;
}

/** Get the inbox for an agent — optionally filtered to unread only. */
export async function getAgentInbox(
  workspaceId: string,
  agentId: string,
  opts?: { unreadOnly?: boolean; limit?: number },
): Promise<AgentMessage[]> {
  const pool = getPool();
  const limit = opts?.limit ?? 50;
  const conditions = ["workspace_id = $1", "to_agent_id = $2"];
  const values: unknown[] = [workspaceId, agentId];

  if (opts?.unreadOnly) {
    conditions.push("read_at IS NULL");
  }

  const where = conditions.join(" AND ");
  const { rows } = await pool.query(
    `SELECT * FROM agent_messages WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length + 1}`,
    [...values, limit],
  );

  return rows.map(rowToMessage);
}

/** Mark a single message as read. */
export async function markMessageRead(messageId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE agent_messages SET read_at = now() WHERE id = $1 AND read_at IS NULL",
    [messageId],
  );
}

/** Get the conversation between two agents (messages in both directions). */
export async function getConversation(
  workspaceId: string,
  agentId1: string,
  agentId2: string,
  limit = 50,
): Promise<AgentMessage[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_messages
     WHERE workspace_id = $1
       AND ((from_agent_id = $2 AND to_agent_id = $3) OR (from_agent_id = $3 AND to_agent_id = $2))
     ORDER BY created_at DESC
     LIMIT $4`,
    [workspaceId, agentId1, agentId2, limit],
  );

  return rows.map(rowToMessage);
}
