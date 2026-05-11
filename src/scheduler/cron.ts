import cron from "node-cron";
import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import { getPool } from "../config/postgres.js";
import { runConsolidation } from "../memory/consolidation.js";
import { runScheduledSummarization } from "../memory/summarizer.js";
import { runReinforcementDecay } from "../memory/auto-extract.js";
import { cleanupExpiredPayloads } from "../inference/payload-audit.js";
import { pruneExpiredRevocations } from "../auth/jwt.js";
import { checkAllWorkspaceSlos } from "../observability/slo-monitor.js";
import { applyExpiryPoliciesAllWorkspaces } from "../memory/expiry.js";
import { detectCostAnomaliesAllWorkspaces } from "../observability/cost-anomaly.js";
import { runMemoryDoctor } from "../memory/doctor.js";
import { checkCachePressure } from "../cache/pressure-monitor.js";
import { prewarmFromPatterns } from "../cache/prewarm-query-patterns.js";
import { runSyntheticTransactions } from "../heartbeat/synthetic-tx.js";
import { createLogger } from "../utils/logger.js";
import { warmCacheFromPredictions } from "../cache/ml-cache-warmer.js";

// ── In-Process Cron Scheduler ───────────────────────────────────────
// Generic scheduler that can run any registered agent autonomously.
// No hardcoded agent references — agents opt into scheduled runs
// via their config or external scheduling configuration.

const log = createLogger("scheduler");

let _tasks: cron.ScheduledTask[] = [];

export async function startScheduler(_resolveClient: (config: AgentConfig) => InferenceClient): Promise<void> {
  log.active("Cron scheduler ready");

  // Clean up expired refresh tokens daily at 3am
  const tokenCleanup = cron.schedule("0 3 * * *", async () => {
    try {
      const pool = getPool();
      await pool.query(
        "DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = true",
      );
      log.dim("Cleaned up expired refresh tokens");
    } catch (err) {
      log.error("Token cleanup error:", err);
    }
  });
  _tasks.push(tokenCleanup);

  // Prune expired revoked access tokens daily at 3:15am
  const revocationCleanup = cron.schedule("15 3 * * *", async () => {
    try {
      await pruneExpiredRevocations();
    } catch (err) {
      log.error("Revocation cleanup error:", err);
    }
  });
  _tasks.push(revocationCleanup);

  // Memory auto-consolidation daily at 4am
  const memoryConsolidation = cron.schedule("0 4 * * *", async () => {
    await runConsolidation();
  });
  _tasks.push(memoryConsolidation);

  // Daily memory entry weight decay — 4:15am
  const memoryDecay = cron.schedule("15 4 * * *", async () => {
    try {
      const pool = getPool();
      // Decay entries older than 7 days: reduce weight by 0.12 per day beyond 7
      // We update the JSONB array directly in Postgres
      await pool.query(`
        UPDATE daily_memory
        SET entries = (
          SELECT jsonb_agg(
            CASE
              WHEN (entry->>'weight') IS NULL AND date < (CURRENT_DATE - INTERVAL '7 days')
              THEN jsonb_set(entry, '{weight}', to_jsonb(GREATEST(0.0, 1.0 - (CURRENT_DATE - date::date - 7) * 0.12)))
              WHEN (entry->>'weight') IS NOT NULL AND date < (CURRENT_DATE - INTERVAL '7 days')
              THEN jsonb_set(entry, '{weight}', to_jsonb(GREATEST(0.0, (entry->>'weight')::float - 0.12)))
              ELSE entry
            END
          )
          FROM jsonb_array_elements(entries) AS entry
        ),
        updated_at = NOW()
        WHERE date < (CURRENT_DATE - INTERVAL '7 days')::text
      `);
      log.dim("Daily memory weight decay applied");
    } catch (err) {
      log.error("Memory decay error:", err);
    }
  });
  _tasks.push(memoryDecay);

  // Memory summarization daily at 5am
  const summarization = cron.schedule("0 5 * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM daily_memory
         WHERE date >= (CURRENT_DATE - INTERVAL '2 days')::text`,
      );
      const { getAgentConfig } = await import("../config/agents.js");
      const agentConfig = getAgentConfig("default");
      const client = _resolveClient(agentConfig);
      for (const row of rows) {
        await runScheduledSummarization(row.user_id, client).catch((err: unknown) => {
          log.error(`Summarization failed for ${row.user_id}:`, err);
        });
      }
      log.dim("Daily memory summarization complete");
    } catch (err) {
      log.error("Summarization error:", err);
    }
  });
  _tasks.push(summarization);

  // Inference payload TTL cleanup daily at 3:30am
  const payloadCleanup = cron.schedule("30 3 * * *", async () => {
    try {
      await cleanupExpiredPayloads();
    } catch (err) {
      log.error("Inference payload cleanup error:", err);
    }
  });
  _tasks.push(payloadCleanup);

  // Memory Doctor — daily at 3:30am (canonicalize + consolidate duplicate daily_notes)
  const memoryDoctor = cron.schedule("30 3 * * *", async () => {
    try {
      const result = await runMemoryDoctor();
      if (result.merged > 0 || result.canonicalized > 0) {
        log.info(`Memory doctor: merged=${result.merged}, canonicalized=${result.canonicalized}`);
      } else {
        log.dim("Memory doctor: no entries needed merging");
      }
    } catch (err) {
      log.error("Memory doctor error:", err);
    }
  });
  _tasks.push(memoryDoctor);

  // Knowledge graph reinforcement decay weekly (Sunday 4:30am)
  const graphDecay = cron.schedule("30 4 * * 0", async () => {
    try {
      await runReinforcementDecay();
      log.dim("Graph reinforcement decay applied");
    } catch (err) {
      log.error("Graph decay error:", err);
    }
  });
  _tasks.push(graphDecay);

  // Dream mode scheduling — dynamically set per user
  // The dream scheduler checks user_dream_configs and triggers
  // dream sessions at each user's configured time.
  const dreamCheck = cron.schedule("*/30 * * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ uid: string; config: any }>(
        `SELECT uid, config FROM user_dream_configs
         WHERE (config->>'enabled')::boolean = true`,
      );

      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      for (const row of rows) {
        const cfg = row.config;
        const schedHour = cfg.scheduleHour ?? 23;
        const schedMinute = cfg.scheduleMinute ?? 0;

        // Check if we're within the 30-min check window of the scheduled time
        if (currentHour === schedHour && Math.abs(currentMinute - schedMinute) < 30) {
          // Check if dream already ran today
          const { rows: existing } = await pool.query(
            `SELECT id FROM dream_sessions WHERE uid = $1
             AND created_at > NOW() - INTERVAL '20 hours'
             LIMIT 1`,
            [row.uid],
          );
          if (existing.length > 0) continue;

          log.dim(`Dream time for user ${row.uid}`);
          // Dream sessions are triggered via the gateway event bus
          // which sends the dream prompt to the user's active channel
          const { getEventBus } = await import("../events/index.js");
          getEventBus().emit("dream.scheduled" as any, {
            uid: row.uid,
            config: cfg,
          });
        }
      }
    } catch (err) {
      log.dim(`Dream schedule check: ${err}`);
    }
  });
  _tasks.push(dreamCheck);

  // Research task iteration scheduler — runs active research every 30min
  const researchCheck = cron.schedule("*/30 * * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ id: string; config: any }>(
        `SELECT id, config FROM research_tasks
         WHERE status IN ('planning', 'researching')`,
      );

      for (const row of rows) {
        const task = row.config;
        const intervalMs = (task.config?.intervalMinutes ?? 120) * 60_000;
        const lastIter = task.progress?.lastIterationAt ?? task.startedAt ?? 0;

        if (Date.now() - lastIter >= intervalMs) {
          log.dim(`Running research iteration for task ${row.id}`);
          const { runResearchIteration } = await import("../agents/deep-research.js");
          const { getAgentConfig } = await import("../config/agents.js");
          const agentId = task.config?.agentId ?? "researcher";
          const agentConfig = getAgentConfig(agentId);
          const client = _resolveClient(agentConfig);
          await runResearchIteration(row.id, client).catch((err: unknown) => {
            log.error(`Research iteration failed for ${row.id}:`, err);
          });
        }
      }
    } catch (err) {
      log.dim(`Research schedule check: ${err}`);
    }
  });
  _tasks.push(researchCheck);

  // Daily cost snapshot at 1am — aggregates billing_usage into cost_snapshots
  const costSnapshot = cron.schedule("0 1 * * *", async () => {
    try {
      const { snapshotCosts } = await import("../billing/cost-dashboard.js");
      await snapshotCosts();
      log.dim("Daily cost snapshot complete");
    } catch (err) {
      log.error("Cost snapshot error:", err);
    }
  });
  _tasks.push(costSnapshot);

  // Heartbeat monitor — checks for due heartbeats every 5 minutes
  const heartbeatCheck = cron.schedule("*/5 * * * *", async () => {
    try {
      const { runDueHeartbeats } = await import("../heartbeat/runner.js");
      await runDueHeartbeats(_resolveClient);
    } catch (err) {
      log.error("Heartbeat check error:", err);
    }
  });
  _tasks.push(heartbeatCheck);

  // Memory retention TTL purge — daily at 2:30am
  const memoryRetention = cron.schedule("30 2 * * *", async () => {
    try {
      const pool = getPool();
      const { loadEnv } = await import("../config/env.js");
      const env = loadEnv();
      const globalTtl = env.memoryTtlDays;

      // Load per-workspace policies
      let workspacePolicies: Array<{ workspace_id: string; ttl_days: number }> = [];
      try {
        const { rows } = await pool.query<{ workspace_id: string; ttl_days: number }>(
          "SELECT workspace_id, ttl_days FROM memory_retention_policies",
        );
        workspacePolicies = rows;
      } catch {
        // Table may not exist yet — use global TTL only
      }

      let totalPurged = 0;

      // Purge per-workspace with their specific TTL
      for (const policy of workspacePolicies) {
        const ttl = policy.ttl_days;

        const sessResult = await pool.query(
          `DELETE FROM sessions WHERE workspace_id = $1 AND updated_at < NOW() - INTERVAL '1 day' * $2`,
          [policy.workspace_id, ttl],
        );
        totalPurged += sessResult.rowCount ?? 0;

        const dailyResult = await pool.query(
          `DELETE FROM daily_memory WHERE workspace_id = $1 AND date < (CURRENT_DATE - INTERVAL '1 day' * $2)::text AND (pinned IS NOT TRUE)`,
          [policy.workspace_id, ttl],
        );
        totalPurged += dailyResult.rowCount ?? 0;

        const profileResult = await pool.query(
          `DELETE FROM user_profiles WHERE workspace_id = $1 AND updated_at < NOW() - INTERVAL '1 day' * $2`,
          [policy.workspace_id, ttl],
        );
        totalPurged += profileResult.rowCount ?? 0;
      }

      // Purge records without a workspace-specific policy using the global TTL
      const excludeIds = workspacePolicies.map((p) => p.workspace_id);
      const excludeClause = excludeIds.length > 0
        ? `AND (workspace_id IS NULL OR workspace_id NOT IN (${excludeIds.map((_, i) => `$${i + 2}`).join(",")}))`
        : "";
      const globalParams: (string | number)[] = [globalTtl, ...excludeIds];

      const gSess = await pool.query(
        `DELETE FROM sessions WHERE updated_at < NOW() - INTERVAL '1 day' * $1 ${excludeClause}`,
        globalParams,
      );
      totalPurged += gSess.rowCount ?? 0;

      const gDaily = await pool.query(
        `DELETE FROM daily_memory WHERE date < (CURRENT_DATE - INTERVAL '1 day' * $1)::text AND (pinned IS NOT TRUE) ${excludeClause}`,
        globalParams,
      );
      totalPurged += gDaily.rowCount ?? 0;

      const gProfile = await pool.query(
        `DELETE FROM user_profiles WHERE updated_at < NOW() - INTERVAL '1 day' * $1 ${excludeClause}`,
        globalParams,
      );
      totalPurged += gProfile.rowCount ?? 0;

      if (totalPurged > 0) {
        log.info(`Memory retention purge: ${totalPurged} expired records deleted`);
      } else {
        log.dim("Memory retention purge: no expired records");
      }
    } catch (err) {
      log.error("Memory retention purge error:", err);
    }
  });
  _tasks.push(memoryRetention);

  // SLO check — every 5 minutes
  const sloCheck = cron.schedule("*/5 * * * *", async () => {
    try {
      await checkAllWorkspaceSlos();
    } catch (err) {
      log.error("SLO check error:", err);
    }
  });
  _tasks.push(sloCheck);

  // Memory expiry policy enforcement — daily at 3:00 AM
  const memoryExpiry = cron.schedule("0 3 * * *", async () => {
    try {
      await applyExpiryPoliciesAllWorkspaces();
      log.dim("Memory expiry policies applied");
    } catch (err) {
      log.error("Memory expiry error:", err);
    }
  });
  _tasks.push(memoryExpiry);

  // Cost anomaly detection — every hour at minute 0
  const costAnomalyCheck = cron.schedule("0 * * * *", async () => {
    try {
      await detectCostAnomaliesAllWorkspaces();
    } catch (err) {
      log.error("Cost anomaly detection error:", err);
    }
  });
  _tasks.push(costAnomalyCheck);

  // DLQ stats — every 6 hours
  const dlqStats = cron.schedule("0 */6 * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM dead_letter_queue WHERE resolved = false",
      );
      const count = parseInt(rows[0]?.count ?? "0", 10);
      if (count > 0) {
        log.warn(`DLQ stats: ${count} unresolved entr${count === 1 ? "y" : "ies"} in dead letter queue`);
      } else {
        log.dim("DLQ stats: no unresolved entries");
      }
    } catch (err) {
      log.error("DLQ stats error:", err);
    }
  });
  _tasks.push(dlqStats);

  // Memory dedup — weekly Sunday at 4:45am
  const memoryDedup = cron.schedule("45 4 * * 0", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM daily_memory
         WHERE date >= (CURRENT_DATE - INTERVAL '30 days')::text
         LIMIT 200`,
      );
      const { runMemoryDeduplication } = await import("../memory/dedup.js");
      let totalDeduped = 0;
      for (const row of rows) {
        const result = await runMemoryDeduplication(row.user_id).catch(() => ({ consolidated: 0 }));
        totalDeduped += result.consolidated;
      }
      if (totalDeduped > 0) {
        log.info(`Memory dedup: consolidated ${totalDeduped} duplicate entries`);
      } else {
        log.dim("Memory dedup: no duplicates found");
      }
    } catch (err) {
      log.error("Memory dedup error:", err);
    }
  });
  _tasks.push(memoryDedup);

  // Cold store snapshot — weekly Sunday at 5:30am
  const coldStoreSnapshot = cron.schedule("30 5 * * 0", async () => {
    try {
      const { loadEnv } = await import("../config/env.js");
      const env = loadEnv();
      if (!env.coldStoreBackend) return;

      const { snapshotMemory } = await import("../memory/cold-store.js");
      const pool = getPool();
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM daily_memory
         WHERE date >= (CURRENT_DATE - INTERVAL '7 days')::text
         LIMIT 200`,
      );
      let snapshotCount = 0;
      for (const row of rows) {
        await snapshotMemory(row.user_id).catch((err: unknown) => {
          log.error(`Cold store snapshot failed for ${row.user_id}:`, err);
        });
        snapshotCount++;
      }
      log.dim(`Cold store: ${snapshotCount} user snapshots archived`);
    } catch (err) {
      log.error("Cold store snapshot error:", err);
    }
  });
  _tasks.push(coldStoreSnapshot);

  // Memory curation — every 4 hours, extract entities and resolve contradictions
  const memoryCuration = cron.schedule("0 */4 * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM daily_memory
         WHERE date >= (CURRENT_DATE - INTERVAL '2 days')::text
         LIMIT 50`,
      );
      const { runCurator } = await import("../agents/curator.js");
      const { getAgentConfig } = await import("../config/agents.js");
      const agentConfig = getAgentConfig("default");
      const client = _resolveClient(agentConfig);
      for (const row of rows) {
        await runCurator(row.user_id, client).catch((err: unknown) => {
          log.error(`Curation failed for ${row.user_id}:`, err);
        });
      }
      log.dim("Memory curation cycle complete");
    } catch (err) {
      log.error("Memory curation error:", err);
    }
  });
  _tasks.push(memoryCuration);

  // Mesh gossip: prune stale nodes — every 2 minutes
  const meshPrune = cron.schedule("*/2 * * * *", async () => {
    try {
      const { pruneStaleMeshNodes } = await import("../agents/mesh-gossip.js");
      await pruneStaleMeshNodes();
    } catch (err) {
      log.dim(`Mesh prune: ${err}`);
    }
  });
  _tasks.push(meshPrune);

  // Persona evolution — daily at 6am (opt-in per agent)
  const personaEvolution = cron.schedule("0 6 * * *", async () => {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM agent_configs WHERE config->>'evolutionEnabled' = 'true'`,
      );
      if (rows.length === 0) return;
      const { runEvolutionCycle } = await import("../agents/persona-evolution.js");
      const { getAgentConfig } = await import("../config/agents.js");
      for (const row of rows) {
        try {
          const agentConfig = getAgentConfig(row.id);
          const client = _resolveClient(agentConfig);
          await runEvolutionCycle(row.id, "system", client);
        } catch (err) {
          log.error(`Evolution failed for ${row.id}:`, err);
        }
      }
      log.dim("Persona evolution cycle complete");
    } catch (err) {
      log.error("Persona evolution error:", err);
    }
  });
  _tasks.push(personaEvolution);

  // Cache pressure monitor — every minute
  const cachePressureCheck = cron.schedule("*/1 * * * *", async () => {
    try {
      await checkCachePressure();
    } catch (err) {
      log.dim(`Cache pressure check: ${err}`);
    }
  });
  _tasks.push(cachePressureCheck);

  // Prewarm from query patterns — every 6 hours
  const prewarmPatterns = cron.schedule("0 */6 * * *", async () => {
    try {
      await prewarmFromPatterns();
    } catch (err) {
      log.dim(`Prewarm from patterns: ${err}`);
    }
  });
  _tasks.push(prewarmPatterns);

  // Synthetic transactions — every 15 minutes
  const syntheticTx = cron.schedule("*/15 * * * *", async () => {
    try {
      await runSyntheticTransactions();
    } catch (err) {
      log.dim(`Synthetic transactions: ${err}`);
    }
  });
  _tasks.push(syntheticTx);

  // ML cache warming from predictions — hourly at minute 0
  const mlCacheWarm = cron.schedule("0 * * * *", async () => {
    try {
      const { loadEnv } = await import("../config/env.js");
      const env = loadEnv();
      if (!env.mlCacheWarmingEnabled) return;

      // Get all agent configs and warm each one
      const { getAllAgentConfigs } = await import("../config/agents.js");
      const allConfigs = getAllAgentConfigs();
      for (const [agentId] of allConfigs) {
        await warmCacheFromPredictions(agentId).catch((err: unknown) => {
          log.dim(`Cache warming failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      log.dim("ML cache warming cycle complete");
    } catch (err) {
      log.dim(`ML cache warming: ${err}`);
    }
  });
  _tasks.push(mlCacheWarm);

  // ── Config-driven scheduled agents (from astra.yml schedule blocks) ──
  const { getAllAgentConfigs } = await import("../config/agents.js");
  const { runAutonomousAgent } = await import("../agents/autonomous.js");
  const allConfigs = getAllAgentConfigs();

  for (const [agentId, agentConfig] of allConfigs) {
    if (!agentConfig.schedule) continue;
    const { cron: cronExpr, taskMessage, uid: customUid } = agentConfig.schedule;

    if (!cron.validate(cronExpr)) {
      log.error(`[scheduled] Invalid cron for ${agentId}: "${cronExpr}"`);
      continue;
    }

    const task = cron.schedule(cronExpr, async () => {
      try {
        const uid = customUid ?? `scheduled:${agentId}`;
        const client = _resolveClient(agentConfig);

        // Ensure system user exists (sessions FK requires a valid users row)
        const pool = getPool();
        await pool.query(
          `INSERT INTO users (id, email, password_hash, display_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [uid, `${uid}@system`, "system", agentConfig.displayName],
        );

        log.info(`[scheduled] Starting ${agentId}`);
        await runAutonomousAgent(uid, agentConfig, taskMessage, client);
        log.info(`[scheduled] ${agentId} complete`);
      } catch (err) {
        log.error(`[scheduled] ${agentId} failed:`, err);
      }
    });
    _tasks.push(task);
    log.dim(`Scheduled ${agentId}: ${cronExpr}`);
  }

  log.dim("Scheduled: cost snapshot (1am), memory retention (2:30am), token cleanup (3am), memory expiry (3am), revocation prune (3:15am), memory doctor (3:30am), payload cleanup (3:30am), consolidation (4am), memory decay (4:15am), summarization (5am), persona evolution (6am), graph decay (Sun 4:30am), memory dedup (Sun 4:45am), cold store (Sun 5:30am), dream check (*/30m), research check (*/30m), heartbeat check (*/5m), SLO check (*/5m), cost anomaly (*/1h), memory curation (*/4h), DLQ stats (*/6h), mesh prune (*/2m), cache pressure (*/1m), prewarm patterns (*/6h), synthetic tx (*/15m), ML cache warming (*/1h)");

  // Dynamic scheduled agents — load from DB and register (rec 18)
  await loadDynamicScheduledAgents(_resolveClient);
}

// ── Dynamic Scheduled Agents ────────────────────────────────────────
// Reads the scheduled_agents table and registers each enabled row as a
// live cron job. Re-call to pick up newly inserted rows at runtime.

export async function loadDynamicScheduledAgents(
  resolveClient: (config: AgentConfig) => InferenceClient,
): Promise<void> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      agent_id: string;
      cron_expression: string;
      input_message: string;
      surface: string;
      surface_id: string;
    }>(
      `SELECT id, agent_id, cron_expression, input_message, surface, surface_id
       FROM scheduled_agents WHERE enabled = true`,
    );

    let registered = 0;
    for (const row of rows) {
      if (!cron.validate(row.cron_expression)) {
        log.error(`[scheduled-agents] Invalid cron for id=${row.id}: "${row.cron_expression}"`);
        continue;
      }

      const task = cron.schedule(row.cron_expression, async () => {
        log.dim(`[scheduled-agents] Running id=${row.id} agent=${row.agent_id}`);
        try {
          const { getAgentConfig } = await import("../config/agents.js");
          const { runAgentLoop } = await import("../agents/loop.js");
          const agentConfig = getAgentConfig(row.agent_id);
          const client = resolveClient(agentConfig);
          const syntheticUid = `scheduled:${row.id}`;
          await runAgentLoop(syntheticUid, row.input_message, agentConfig, client, {
            uid: syntheticUid,
            surface: row.surface as import("../sessions/types.js").SessionSurface,
            surfaceId: row.surface_id,
          });
          await pool.query(
            "UPDATE scheduled_agents SET last_run_at = NOW(), last_run_error = NULL WHERE id = $1",
            [row.id],
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[scheduled-agents] Failed id=${row.id}: ${msg}`);
          await pool.query(
            "UPDATE scheduled_agents SET last_run_at = NOW(), last_run_error = $2 WHERE id = $1",
            [row.id, msg],
          );
        }
      });
      _tasks.push(task);
      registered++;
    }

    if (registered > 0) {
      log.dim(`[scheduled-agents] Registered ${registered} dynamic job(s) from DB`);
    }
  } catch (err) {
    log.error("[scheduled-agents] Failed to load dynamic schedules:", err);
  }
}

export function stopScheduler(): void {
  for (const task of _tasks) {
    task.stop();
  }
  _tasks = [];
  log.warn("Cron jobs stopped");
}
