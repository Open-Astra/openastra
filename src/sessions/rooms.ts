import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("rooms");

export async function createRoom(sessionId: string, creatorUid: string, workspaceId: string): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO session_rooms (id, workspace_id, session_id, created_by) VALUES ($1, $2, $3, $4)`,
    [id, workspaceId, sessionId, creatorUid],
  );
  await joinRoom(id, creatorUid);
  log.info(`Room created id=${id} session=${sessionId} creator=${creatorUid}`);
  return id;
}

export async function joinRoom(roomId: string, uid: string): Promise<void> {
  await getPool().query(
    `INSERT INTO session_room_members (room_id, uid) VALUES ($1, $2)
     ON CONFLICT (room_id, uid) DO UPDATE SET left_at = NULL`,
    [roomId, uid],
  );
}

export async function leaveRoom(roomId: string, uid: string): Promise<void> {
  await getPool().query(
    `UPDATE session_room_members SET left_at = NOW() WHERE room_id = $1 AND uid = $2`,
    [roomId, uid],
  );
}

export async function getRoomMembers(roomId: string): Promise<string[]> {
  const result = await getPool().query<{ uid: string }>(
    `SELECT uid FROM session_room_members WHERE room_id = $1 AND left_at IS NULL`,
    [roomId],
  );
  return result.rows.map((r) => r.uid);
}

export async function getRoom(
  roomId: string,
  workspaceId: string,
): Promise<{ id: string; sessionId: string; createdBy: string; createdAt: Date } | null> {
  const result = await getPool().query<{
    id: string;
    session_id: string;
    created_by: string;
    created_at: Date;
  }>(
    `SELECT id, session_id, created_by, created_at FROM session_rooms WHERE id = $1 AND workspace_id = $2`,
    [roomId, workspaceId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
