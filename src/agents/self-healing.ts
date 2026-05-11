import { getPool } from "../config/postgres.js";
import { runAgentLoop } from "./loop.js";
import { getAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { logAgentAction } from "./audit.js";
import { createLogger } from "../utils/logger.js";

// ── Self-Healing Agent System ───────────────────────────────────────
// Monitors agent health, auto-restarts failed agents, and triggers
// auto-compaction when context windows grow too large.
//
// Features:
//   - Heartbeat monitoring for long-running agents
//   - Auto-restart on crash with exponential backoff
//   - Auto-compaction when context > threshold
//   - Dead session cleanup
//   - Health dashboard for observability

const log = createLogger("self-healing");

// ── Types ───────────────────────────────────────────────────────────

export interface AgentHealthRecord {
  agentId: string;
  sessionId: string;
  uid: string;
  status: "healthy" | "degraded" | "failed" | "restarting";
  lastHeartbeat: number;
  consecutiveFailures: number;
  totalRestarts: number;
  lastError?: string;
  contextSize: number;           // current context message count
  contextTokenEstimate: number;  // estimated tokens in context
}

export interface SelfHealingConfig {
  heartbeatIntervalMs: number;     // check interval (default: 30s)
  maxConsecutiveFailures: number;   // failures before restart (default: 3)
  maxRestarts: number;              // max restarts before giving up (default: 5)
  restartBackoffMs: number;         // initial backoff (default: 5s)
  compactionThreshold: number;      // trigger compaction at this message count (default: 40)
  compactionTokenThreshold: number; // trigger at this token count (default: 80000)
  deadSessionTimeoutMs: number;     // clean up sessions idle for this long (default: 24h)
  enabled: boolean;
}

const DEFAULT_CONFIG: SelfHealingConfig = {
  heartbeatIntervalMs: 30_000,
  maxConsecutiveFailures: 3,
  maxRestarts: 5,
  restartBackoffMs: 5_000,
  compactionThreshold: 40,
  compactionTokenThreshold: 80_000,
  deadSessionTimeoutMs: 86_400_000, // 24 hours
  enabled: true,
};

// ── Health Registry ─────────────────────────────────────────────────

const healthRegistry = new Map<string, AgentHealthRecord>();
let healingInterval: ReturnType<typeof setInterval> | null = null;
let activeConfig: SelfHealingConfig = DEFAULT_CONFIG;

// ── Start/Stop ──────────────────────────────────────────────────────

export function startSelfHealing(config: Partial<SelfHealingConfig> = {}): void {
  activeConfig = { ...DEFAULT_CONFIG, ...config };
  if (!activeConfig.enabled) return;

  healingInterval = setInterval(runHealthCheck, activeConfig.heartbeatIntervalMs);
  log.info(`Self-healing started (check every ${activeConfig.heartbeatIntervalMs}ms)`);
}

export function stopSelfHealing(): void {
  if (healingInterval) {
    clearInterval(healingInterval);
    healingInterval = null;
  }
  log.info("Self-healing stopped");
}

// ── Record Health ───────────────────────────────────────────────────

export function recordHeartbeat(
  agentId: string,
  sessionId: string,
  uid: string,
  contextSize: number = 0,
  contextTokens: number = 0,
): void {
  const key = `${agentId}:${sessionId}`;
  const existing = healthRegistry.get(key);

  healthRegistry.set(key, {
    agentId,
    sessionId,
    uid,
    status: "healthy",
    lastHeartbeat: Date.now(),
    consecutiveFailures: 0,
    totalRestarts: existing?.totalRestarts ?? 0,
    contextSize,
    contextTokenEstimate: contextTokens,
  });
}

export function recordFailure(
  agentId: string,
  sessionId: string,
  uid: string,
  error: string,
): void {
  const key = `${agentId}:${sessionId}`;
  const existing = healthRegistry.get(key);

  const record: AgentHealthRecord = {
    agentId,
    sessionId,
    uid,
    status: "degraded",
    lastHeartbeat: existing?.lastHeartbeat ?? Date.now(),
    consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
    totalRestarts: existing?.totalRestarts ?? 0,
    lastError: error,
    contextSize: existing?.contextSize ?? 0,
    contextTokenEstimate: existing?.contextTokenEstimate ?? 0,
  };

  if (record.consecutiveFailures >= activeConfig.maxConsecutiveFailures) {
    record.status = "failed";
  }

  healthRegistry.set(key, record);
}

// ── Health Check ────────────────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
  for (const [key, record] of healthRegistry) {
    // Check for failed agents needing restart
    if (record.status === "failed" && record.totalRestarts < activeConfig.maxRestarts) {
      await restartAgent(record);
    }

    // Check for context compaction needs
    if (
      record.status === "healthy" &&
      (record.contextSize > activeConfig.compactionThreshold ||
        record.contextTokenEstimate > activeConfig.compactionTokenThreshold)
    ) {
      await triggerCompaction(record);
    }

    // Clean up stale entries
    if (Date.now() - record.lastHeartbeat > activeConfig.deadSessionTimeoutMs) {
      healthRegistry.delete(key);
    }
  }

  // Clean up dead sessions in DB
  await cleanDeadSessions().catch((err) => {
    log.dim(`Dead session cleanup failed: ${err}`);
  });
}

// ── Auto-Restart ────────────────────────────────────────────────────

async function restartAgent(record: AgentHealthRecord): Promise<void> {
  log.info(`Restarting agent ${record.agentId} (session: ${record.sessionId.slice(0, 8)}, restarts: ${record.totalRestarts})`);

  record.status = "restarting";
  record.totalRestarts++;

  // Exponential backoff
  const backoff = activeConfig.restartBackoffMs * Math.pow(2, record.totalRestarts - 1);
  await new Promise((r) => setTimeout(r, Math.min(backoff, 60_000)));

  try {
    const agentConfig = getAgentConfig(record.agentId);
    const client = getInferenceClientForAgent(agentConfig);

    // Run a health check message through the agent
    await runAgentLoop(
      record.uid,
      "[System] Health check — agent restarted after failure.",
      agentConfig,
      client,
      { uid: record.uid, surface: "prop", surfaceId: record.sessionId },
    );

    record.status = "healthy";
    record.consecutiveFailures = 0;
    record.lastHeartbeat = Date.now();

    await logAgentAction(record.uid, record.agentId, "agent_restarted" as any, {
      sessionId: record.sessionId,
      restartCount: record.totalRestarts,
      lastError: record.lastError,
    });

    log.info(`Agent ${record.agentId} restarted successfully`);
  } catch (err) {
    record.status = "failed";
    record.lastError = err instanceof Error ? err.message : String(err);
    log.error(`Restart failed for ${record.agentId}:`, err);
  }
}

// ── Auto-Compaction ─────────────────────────────────────────────────

async function triggerCompaction(record: AgentHealthRecord): Promise<void> {
  const pool = getPool();

  log.dim(`Triggering compaction for ${record.agentId} (${record.contextSize} messages, ~${record.contextTokenEstimate} tokens)`);

  try {
    // Mark old messages as compacted
    await pool.query(
      `UPDATE messages
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"compacted": true}'::jsonb
       WHERE session_id = $1
         AND created_at < NOW() - INTERVAL '1 hour'
         AND (metadata->>'compacted') IS NULL
       ORDER BY created_at ASC
       LIMIT $2`,
      [record.sessionId, Math.floor(record.contextSize / 2)],
    );

    record.contextSize = Math.floor(record.contextSize / 2);

    await logAgentAction(record.uid, record.agentId, "auto_compaction" as any, {
      sessionId: record.sessionId,
      messagesCompacted: Math.floor(record.contextSize),
    });
  } catch (err) {
    log.dim(`Compaction failed for ${record.agentId}: ${err}`);
  }
}

// ── Dead Session Cleanup ────────────────────────────────────────────

async function cleanDeadSessions(): Promise<number> {
  const pool = getPool();
  const cutoffMs = Number(activeConfig.deadSessionTimeoutMs);
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return 0;
  const cutoff = new Date(Date.now() - cutoffMs).toISOString();

  const result = await pool.query(
    `UPDATE sessions
     SET status = 'archived'
     WHERE status = 'active'
       AND last_active_at < $1
       AND last_active_at IS NOT NULL`,
    [cutoff],
  );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    log.dim(`Archived ${count} dead sessions`);
  }
  return count;
}

// ── Health Dashboard ────────────────────────────────────────────────

export function getHealthDashboard(): {
  totalAgents: number;
  healthy: number;
  degraded: number;
  failed: number;
  restarting: number;
  records: AgentHealthRecord[];
} {
  const records = [...healthRegistry.values()];
  return {
    totalAgents: records.length,
    healthy: records.filter((r) => r.status === "healthy").length,
    degraded: records.filter((r) => r.status === "degraded").length,
    failed: records.filter((r) => r.status === "failed").length,
    restarting: records.filter((r) => r.status === "restarting").length,
    records,
  };
}
