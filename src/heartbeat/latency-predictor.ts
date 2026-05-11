// ── Latency Trend Predictor ────────────────────────────────────────────
// Tracks inference latency trends and alerts on degradation.
// Uses simple linear regression to detect sustained latency increases.

import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import { loadEnv } from "../config/env.js";

const log = createLogger("latency-predictor");

// ── Types & Configuration ──────────────────────────────────────────────

interface LatencyTrend {
  slope: number;
  threshold: number;
}

const WINDOW_SIZE = 20; // Track last 20 latencies per provider
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ── State ──────────────────────────────────────────────────────────────

const latencyWindows = new Map<string, number[]>();
const alertCooldowns = new Map<string, number>();

function getOrInitWindow(provider: string): number[] {
  let window = latencyWindows.get(provider);
  if (!window) {
    window = [];
    latencyWindows.set(provider, window);
  }
  return window;
}

// ── Linear Regression ──────────────────────────────────────────────────

function calculateSlope(durations: number[]): number {
  if (durations.length < 2) return 0;

  const n = durations.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = durations[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  // slope = (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
  const numerator = n * sumXY - sumX * sumY;
  const denominator = n * sumX2 - sumX * sumX;

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// ── Event Handler ──────────────────────────────────────────────────────

function onInferenceRequest(payload: Record<string, unknown>): void {
  const provider = payload.provider as string | undefined;
  const durationMs = payload.durationMs as number | undefined;

  if (!provider || durationMs === undefined || durationMs < 0) return;

  const window = getOrInitWindow(provider);
  window.push(durationMs);

  if (window.length > WINDOW_SIZE) {
    window.shift();
  }

  checkLatencyTrend(provider);
}

// ── Trend Detection & Alerting ────────────────────────────────────────

function checkLatencyTrend(provider: string): void {
  const window = latencyWindows.get(provider);
  if (!window || window.length < 5) return; // Need minimum data

  const slope = calculateSlope(window);
  const config = loadEnv();
  const threshold = config.latencyTrendAlertThreshold; // ms/request

  const now = Date.now();
  const lastAlert = alertCooldowns.get(provider);
  const inCooldown = lastAlert && now - lastAlert < ALERT_COOLDOWN_MS;

  if (slope > threshold && !inCooldown) {
    // Note: Custom inference.latency.degraded events are not in events/types.ts
    // These are logged for observability and can be consumed by custom handlers
    alertCooldowns.set(provider, now);
    log.warn(`[${provider}] Latency degradation detected: slope=${Math.round(slope)}ms/request (threshold=${threshold}ms)`);
  }
}

// ── Public API ────────────────────────────────────────────────────────

export function startLatencyPredictor(): void {
  const bus = getEventBus();

  // Subscribe to inference.request events
  bus.on("inference.request", (payload) => {
    onInferenceRequest(payload as Record<string, unknown>);
  });

  log.info("Latency predictor started");
}

export function getLatencyTrends(): Map<string, LatencyTrend> {
  const config = loadEnv();
  const threshold = config.latencyTrendAlertThreshold;
  const trends = new Map<string, LatencyTrend>();

  for (const [provider, window] of latencyWindows) {
    if (window.length >= 5) {
      const slope = calculateSlope(window);
      trends.set(provider, { slope, threshold });
    }
  }

  return trends;
}
