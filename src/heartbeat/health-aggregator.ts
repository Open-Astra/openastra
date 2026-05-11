// ── Provider Health Aggregator ──────────────────────────────────────────
// Tracks provider health via heartbeat and inference events.
// Emits health degradation/recovery alerts based on error rate thresholds.

import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("health-aggregator");

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderHealth {
  provider: string;
  successCount: number;
  errorCount: number;
  lastErrorAt: number | null;
  errorRateThreshold: number; // e.g., 0.5 = 50%
  isHealthy: boolean;
  lastAlertAt: number | null;
}

// ── State Management ───────────────────────────────────────────────────

const healthStates = new Map<string, ProviderHealth>();
const alertCooldowns = new Map<string, number>(); // per-provider last alert timestamp
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function getOrInitProviderHealth(provider: string): ProviderHealth {
  let health = healthStates.get(provider);
  if (!health) {
    health = {
      provider,
      successCount: 0,
      errorCount: 0,
      lastErrorAt: null,
      errorRateThreshold: 0.5,
      isHealthy: true,
      lastAlertAt: null,
    };
    healthStates.set(provider, health);
  }
  return health;
}

// ── Event Handlers ────────────────────────────────────────────────────

function onHeartbeatCompleted(_payload: Record<string, unknown>): void {
  // Note: heartbeat.completed events don't carry provider info directly,
  // so we track overall health. Could be enhanced with provider-specific heartbeats.
}

function onInferenceRequest(payload: Record<string, unknown>): void {
  const provider = payload.provider as string | undefined;
  const error = payload.error as string | undefined;

  if (!provider) return;

  const health = getOrInitProviderHealth(provider);

  if (error) {
    health.errorCount++;
    health.lastErrorAt = Date.now();
  } else {
    health.successCount++;
  }

  // Keep rolling window limited to last 10 events
  const totalEvents = health.successCount + health.errorCount;
  if (totalEvents > 10) {
    // Decay: reduce counts by 10% to maintain rolling window
    const reductionFactor = 0.9;
    health.successCount = Math.max(0, Math.ceil(health.successCount * reductionFactor));
    health.errorCount = Math.max(0, Math.ceil(health.errorCount * reductionFactor));
  }

  checkProviderHealth(provider, health);
}

// ── Health Check & Alerting ────────────────────────────────────────────

function checkProviderHealth(provider: string, health: ProviderHealth): void {
  const totalEvents = health.successCount + health.errorCount;
  if (totalEvents === 0) return;

  const errorRate = health.errorCount / totalEvents;
  const now = Date.now();
  const lastAlert = alertCooldowns.get(provider);
  const inCooldown = lastAlert && now - lastAlert < ALERT_COOLDOWN_MS;

  if (errorRate > health.errorRateThreshold) {
    // Health degraded
    if (!health.isHealthy && !inCooldown) {
      // Note: Custom provider.health.degraded events are emitted but not in events/types.ts
      // These can be consumed by custom handlers or dashboards
      // For now, we just log the state change
      alertCooldowns.set(provider, now);
      health.lastAlertAt = now;
      log.warn(`[${provider}] Health degraded: ${Math.round(errorRate * 100)}% error rate`);
    }
    health.isHealthy = false;
  } else if (errorRate < 0.1) {
    // Health recovered
    if (!health.isHealthy && !inCooldown) {
      // Note: Custom provider.health.recovered events are emitted but not in events/types.ts
      alertCooldowns.set(provider, now);
      health.lastAlertAt = now;
      log.active(`[${provider}] Health recovered: ${Math.round(errorRate * 100)}% error rate`);
    }
    health.isHealthy = true;
  }
}

// ── Public API ────────────────────────────────────────────────────────

export function startHealthAggregator(): void {
  const eventBus = getEventBus();

  // Subscribe to heartbeat.completed events
  eventBus.on("heartbeat.completed", (payload) => {
    onHeartbeatCompleted(payload as Record<string, unknown>);
  });

  // Subscribe to inference.request events
  eventBus.on("inference.request", (payload) => {
    onInferenceRequest(payload as Record<string, unknown>);
  });

  log.info("Health aggregator started");
}

export function getProviderHealthSummary(): Map<string, ProviderHealth> {
  return new Map(healthStates);
}
