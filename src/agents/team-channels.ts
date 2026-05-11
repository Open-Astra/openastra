import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface TeamChannel {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  subscribers: string[];
  messageCount: number;
  createdAt: Date;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  agentId: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export async function createChannel(
  workspaceId: string,
  name: string,
  description?: string,
): Promise<TeamChannel> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO team_topic_channels (id, workspace_id, name, description) VALUES ($1,$2,$3,$4)`,
    [id, workspaceId, name, description ?? null],
  );
  return { id, workspaceId, name, description: description ?? null, subscribers: [], messageCount: 0, createdAt: new Date() };
}

export async function subscribe(channelId: string, agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO team_channel_subscribers (channel_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [channelId, agentId],
  );
}

export async function unsubscribe(channelId: string, agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM team_channel_subscribers WHERE channel_id = $1 AND agent_id = $2`,
    [channelId, agentId],
  );
}

export async function broadcast(
  channelId: string,
  agentId: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<ChannelMessage> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO team_channel_messages (id, channel_id, agent_id, message, metadata)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, channelId, agentId, message, metadata ? JSON.stringify(metadata) : null],
  );
  return { id, channelId, agentId, message, metadata, createdAt: new Date() };
}

export async function getChannels(workspaceId: string): Promise<TeamChannel[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.id, c.workspace_id AS "workspaceId", c.name, c.description, c.created_at AS "createdAt",
            COALESCE(array_agg(DISTINCT s.agent_id) FILTER (WHERE s.agent_id IS NOT NULL), '{}') AS subscribers,
            COUNT(DISTINCT m.id)::int AS "messageCount"
     FROM team_topic_channels c
     LEFT JOIN team_channel_subscribers s ON s.channel_id = c.id
     LEFT JOIN team_channel_messages m ON m.channel_id = c.id
     WHERE c.workspace_id = $1
     GROUP BY c.id ORDER BY c.created_at DESC`,
    [workspaceId],
  );
  return rows as TeamChannel[];
}

export async function getChannel(channelId: string): Promise<TeamChannel | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.id, c.workspace_id AS "workspaceId", c.name, c.description, c.created_at AS "createdAt",
            COALESCE(array_agg(DISTINCT s.agent_id) FILTER (WHERE s.agent_id IS NOT NULL), '{}') AS subscribers,
            COUNT(DISTINCT m.id)::int AS "messageCount"
     FROM team_topic_channels c
     LEFT JOIN team_channel_subscribers s ON s.channel_id = c.id
     LEFT JOIN team_channel_messages m ON m.channel_id = c.id
     WHERE c.id = $1 GROUP BY c.id`,
    [channelId],
  );
  return (rows[0] as TeamChannel) ?? null;
}

export async function deleteChannel(channelId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM team_topic_channels WHERE id = $1`, [channelId]);
}

export async function getMessages(
  channelId: string,
  opts?: { limit?: number; since?: Date },
): Promise<ChannelMessage[]> {
  const pool = getPool();
  const limit = Math.min(opts?.limit ?? 50, 200);
  const since = opts?.since ?? new Date(0);
  const { rows } = await pool.query(
    `SELECT id, channel_id AS "channelId", agent_id AS "agentId", message, metadata, created_at AS "createdAt"
     FROM team_channel_messages WHERE channel_id = $1 AND created_at >= $2
     ORDER BY created_at DESC LIMIT $3`,
    [channelId, since, limit],
  );
  return rows as ChannelMessage[];
}
