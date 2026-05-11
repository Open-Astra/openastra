// ── Channel → Agent Routing ─────────────────────────────────────────
// Maps channel+chat pairs to specific agents. This is how OpenClaw does
// multi-agent routing — different contacts/groups route to different
// agents. We persist these in Postgres so they survive restarts.

import { getPool } from "../config/postgres.js";
import type { ChannelType } from "./base.js";

// ── In-Memory Cache ────────────────────────────────────────────────
// Hot cache to avoid DB lookups on every message. Evicts on writes.

const cache = new Map<string, string>();

function cacheKey(channel: ChannelType | string, chatId: string): string {
  return `${channel}:${chatId}`;
}

// ── Database Operations ────────────────────────────────────────────

export async function getChannelAgentMapping(
  channel: ChannelType | string,
  chatId: string,
): Promise<string | undefined> {
  const key = cacheKey(channel, chatId);

  // Check cache first
  if (cache.has(key)) return cache.get(key);

  try {
    const pool = getPool();
    const { rows } = await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM channel_routing
       WHERE channel = $1 AND chat_id = $2`,
      [channel, chatId],
    );

    if (rows.length > 0) {
      cache.set(key, rows[0]!.agent_id);
      return rows[0]!.agent_id;
    }
  } catch {
    // Table might not exist yet — fall through to undefined
  }

  return undefined;
}

export async function setChannelAgentMapping(
  channel: ChannelType | string,
  chatId: string,
  agentId: string,
): Promise<void> {
  const pool = getPool();
  const key = cacheKey(channel, chatId);

  await pool.query(
    `INSERT INTO channel_routing (channel, chat_id, agent_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (channel, chat_id)
     DO UPDATE SET agent_id = $3, updated_at = NOW()`,
    [channel, chatId, agentId],
  );

  cache.set(key, agentId);
}

export async function deleteChannelAgentMapping(
  channel: ChannelType | string,
  chatId: string,
): Promise<void> {
  const pool = getPool();
  const key = cacheKey(channel, chatId);

  await pool.query(
    "DELETE FROM channel_routing WHERE channel = $1 AND chat_id = $2",
    [channel, chatId],
  );

  cache.delete(key);
}

// ── Default Agent ──────────────────────────────────────────────────
// Fallback when no routing rule matches. Uses env var or first available.

let _defaultAgentId: string | undefined;

export function setDefaultAgentId(agentId: string): void {
  _defaultAgentId = agentId;
}

export function getDefaultAgentId(): string {
  if (_defaultAgentId) return _defaultAgentId;

  // Fallback: env var or hardcoded
  return process.env.DEFAULT_AGENT_ID || "default";
}
