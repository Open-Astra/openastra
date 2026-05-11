import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("load-balancer");

// Worker ID for this process instance
const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

export function getWorkerId(): string {
  return WORKER_ID;
}

export async function registerWorker(agentId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_worker_stats (worker_id, agent_id, active_sessions, last_heartbeat)
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT (worker_id, agent_id) DO UPDATE SET last_heartbeat = NOW()`,
    [WORKER_ID, agentId],
  ).catch(() => {});
}

export async function heartbeat(agentId: string): Promise<void> {
  await getPool().query(
    `UPDATE agent_worker_stats SET last_heartbeat = NOW() WHERE worker_id = $1 AND agent_id = $2`,
    [WORKER_ID, agentId],
  ).catch(() => {});
}

export async function selectWorker(agentId: string): Promise<string> {
  // Return least-loaded worker for this agent
  const result = await getPool().query<{ worker_id: string; active_sessions: number }>(
    `SELECT worker_id, active_sessions FROM agent_worker_stats
     WHERE agent_id = $1 AND last_heartbeat > NOW() - INTERVAL '30 seconds'
     ORDER BY active_sessions ASC LIMIT 1`,
    [agentId],
  );
  return result.rows[0]?.worker_id ?? WORKER_ID;
}

export async function incrementActiveSessions(agentId: string): Promise<void> {
  await getPool().query(
    `UPDATE agent_worker_stats SET active_sessions = active_sessions + 1 WHERE worker_id = $1 AND agent_id = $2`,
    [WORKER_ID, agentId],
  ).catch(() => {});
}

export async function decrementActiveSessions(agentId: string): Promise<void> {
  await getPool().query(
    `UPDATE agent_worker_stats SET active_sessions = GREATEST(0, active_sessions - 1) WHERE worker_id = $1 AND agent_id = $2`,
    [WORKER_ID, agentId],
  ).catch(() => {});
}

log.info(`Load balancer initialized with worker ID: ${WORKER_ID}`);
