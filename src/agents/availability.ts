import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-availability");

type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type WeeklySchedule = {
  [day in DayOfWeek]?: { start: string; end: string };
};

export interface MaintenanceWindow {
  id: string;
  workspaceId: string;
  agentId: string;
  from: string;
  to: string;
  reason: string | null;
  createdAt: string;
}

export interface AgentAvailability {
  agentId: string;
  available: boolean;
  schedule?: WeeklySchedule;
  nextWindow?: MaintenanceWindow;
}

const DAY_MAP: Record<number, DayOfWeek> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

export async function setSchedule(
  workspaceId: string,
  agentId: string,
  schedule: WeeklySchedule,
): Promise<void> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO agent_schedules (id, workspace_id, agent_id, schedule)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE SET schedule = $4, updated_at = now()`,
    [id, workspaceId, agentId, JSON.stringify(schedule)],
  );
  log.info(`Schedule set for agent=${agentId} workspace=${workspaceId}`);
}

export async function addMaintenanceWindow(
  workspaceId: string,
  agentId: string,
  window: { from: Date; to: Date; reason: string },
): Promise<MaintenanceWindow> {
  const id = randomUUID();
  const { rows } = await getPool().query<{ created_at: string }>(
    `INSERT INTO agent_maintenance_windows (id, workspace_id, agent_id, window_from, window_to, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
    [id, workspaceId, agentId, window.from.toISOString(), window.to.toISOString(), window.reason],
  );
  log.info(`Maintenance window added for agent=${agentId}: ${window.from.toISOString()} - ${window.to.toISOString()}`);
  return {
    id,
    workspaceId,
    agentId,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    reason: window.reason,
    createdAt: rows[0]!.created_at,
  };
}

export async function isAvailable(workspaceId: string, agentId: string, at?: Date): Promise<boolean> {
  const now = at ?? new Date();

  const { rows: windowRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM agent_maintenance_windows
     WHERE workspace_id = $1 AND agent_id = $2 AND window_from <= $3 AND window_to >= $3
     LIMIT 1`,
    [workspaceId, agentId, now.toISOString()],
  );
  if (windowRows.length > 0) return false;

  const { rows: schedRows } = await getPool().query<{ schedule: WeeklySchedule }>(
    `SELECT schedule FROM agent_schedules WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  if (schedRows.length === 0) return true;

  const schedule = schedRows[0]!.schedule;
  const day = DAY_MAP[now.getDay()]!;
  const daySchedule = schedule[day];
  if (!daySchedule) return false;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMin = timeToMinutes(daySchedule.start);
  const endMin = timeToMinutes(daySchedule.end);

  return currentMinutes >= startMin && currentMinutes <= endMin;
}

export async function getAvailableAgents(workspaceId: string, at?: Date): Promise<string[]> {
  const now = at ?? new Date();

  const { rows: allAgents } = await getPool().query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM agent_schedules WHERE workspace_id = $1`,
    [workspaceId],
  );

  const available: string[] = [];
  for (const row of allAgents) {
    if (await isAvailable(workspaceId, row.agent_id, now)) {
      available.push(row.agent_id);
    }
  }
  return available;
}

export async function getSchedule(workspaceId: string, agentId: string): Promise<WeeklySchedule | null> {
  const { rows } = await getPool().query<{ schedule: WeeklySchedule }>(
    `SELECT schedule FROM agent_schedules WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  return rows[0]?.schedule ?? null;
}

export async function getMaintenanceWindows(workspaceId: string, agentId: string): Promise<MaintenanceWindow[]> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    window_from: string;
    window_to: string;
    reason: string | null;
    created_at: string;
  }>(
    `SELECT id, workspace_id, agent_id, window_from, window_to, reason, created_at
     FROM agent_maintenance_windows
     WHERE workspace_id = $1 AND agent_id = $2
     ORDER BY window_from ASC`,
    [workspaceId, agentId],
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    from: r.window_from,
    to: r.window_to,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export async function cancelMaintenanceWindow(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM agent_maintenance_windows WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getAgentAvailability(
  workspaceId: string,
  agentId: string,
  at?: Date,
): Promise<AgentAvailability> {
  const now = at ?? new Date();
  const available = await isAvailable(workspaceId, agentId, now);
  const schedule = await getSchedule(workspaceId, agentId);

  const { rows: windowRows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    window_from: string;
    window_to: string;
    reason: string | null;
    created_at: string;
  }>(
    `SELECT id, workspace_id, agent_id, window_from, window_to, reason, created_at
     FROM agent_maintenance_windows
     WHERE workspace_id = $1 AND agent_id = $2 AND window_from >= $3
     ORDER BY window_from ASC LIMIT 1`,
    [workspaceId, agentId, now.toISOString()],
  );

  const nextWindow = windowRows.length > 0
    ? {
        id: windowRows[0]!.id,
        workspaceId: windowRows[0]!.workspace_id,
        agentId: windowRows[0]!.agent_id,
        from: windowRows[0]!.window_from,
        to: windowRows[0]!.window_to,
        reason: windowRows[0]!.reason,
        createdAt: windowRows[0]!.created_at,
      }
    : undefined;

  return {
    agentId,
    available,
    schedule: schedule ?? undefined,
    nextWindow,
  };
}
