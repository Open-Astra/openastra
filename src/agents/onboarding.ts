import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-onboarding");

const ONBOARDING_STEPS = ["team_norms", "shared_context", "history_digest", "capability_calibration"] as const;
type StepName = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  name: StepName;
  status: "pending" | "completed" | "skipped";
  completedAt?: string;
}

export interface OnboardingProcess {
  id: string;
  workspaceId: string;
  agentId: string;
  teamId: string;
  status: "in_progress" | "completed" | "failed";
  steps: OnboardingStep[];
  startedAt: string;
  completedAt?: string;
}

const inMemoryStore = new Map<string, OnboardingProcess>();

function buildInitialSteps(): OnboardingStep[] {
  return ONBOARDING_STEPS.map((name) => ({ name, status: "pending" as const }));
}

export async function startOnboarding(
  workspaceId: string,
  agentId: string,
  teamId: string,
): Promise<OnboardingProcess> {
  const id = randomUUID();
  const steps = buildInitialSteps();
  const now = new Date().toISOString();

  const process: OnboardingProcess = {
    id,
    workspaceId,
    agentId,
    teamId,
    status: "in_progress",
    steps,
    startedAt: now,
  };

  inMemoryStore.set(id, process);

  await getPool()
    .query(
      `INSERT INTO agent_onboarding (id, workspace_id, agent_id, team_id, status, steps, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, workspaceId, agentId, teamId, "in_progress", JSON.stringify(steps), now],
    )
    .catch((err) => log.warn(`DB insert failed for onboarding ${id}: ${err}`));

  log.info(`Started onboarding ${id} for agent=${agentId} team=${teamId}`);
  return process;
}

export async function getOnboardingStatus(onboardingId: string): Promise<OnboardingProcess | null> {
  const cached = inMemoryStore.get(onboardingId);
  if (cached) return cached;

  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    team_id: string;
    status: OnboardingProcess["status"];
    steps: OnboardingStep[];
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT id, workspace_id, agent_id, team_id, status, steps, started_at, completed_at
     FROM agent_onboarding WHERE id = $1`,
    [onboardingId],
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const process: OnboardingProcess = {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    teamId: row.team_id,
    status: row.status,
    steps: row.steps,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
  inMemoryStore.set(process.id, process);
  return process;
}

export async function completeStep(onboardingId: string, step: string): Promise<OnboardingProcess | null> {
  const process = await getOnboardingStatus(onboardingId);
  if (!process || process.status !== "in_progress") return null;

  const target = process.steps.find((s) => s.name === step);
  if (!target || target.status === "completed") return process;

  target.status = "completed";
  target.completedAt = new Date().toISOString();

  const allDone = process.steps.every((s) => s.status === "completed" || s.status === "skipped");
  if (allDone) {
    process.status = "completed";
    process.completedAt = new Date().toISOString();
  }

  inMemoryStore.set(onboardingId, process);

  await getPool()
    .query(
      `UPDATE agent_onboarding SET steps = $1, status = $2, completed_at = $3 WHERE id = $4`,
      [JSON.stringify(process.steps), process.status, process.completedAt ?? null, onboardingId],
    )
    .catch((err) => log.warn(`DB update failed for onboarding ${onboardingId}: ${err}`));

  log.info(`Step "${step}" completed for onboarding ${onboardingId}, status=${process.status}`);
  return process;
}

export async function listOnboardingProcesses(workspaceId: string): Promise<OnboardingProcess[]> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    team_id: string;
    status: OnboardingProcess["status"];
    steps: OnboardingStep[];
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT id, workspace_id, agent_id, team_id, status, steps, started_at, completed_at
     FROM agent_onboarding WHERE workspace_id = $1 ORDER BY started_at DESC`,
    [workspaceId],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    teamId: row.team_id,
    status: row.status,
    steps: row.steps,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  }));
}
