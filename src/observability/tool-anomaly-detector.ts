// ── Tool Usage Anomaly Detection (Feature 38) ───────────────────────
// Rules engine that monitors tool.executed events for anomalous
// patterns: runaway loops, path traversal, frequency spikes, cost
// spikes, and error storms. Emits tool.anomaly events on the bus.

import { getEventBus } from "../events/index.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

const logger = createLogger("tool-anomaly-detector");

// ── Types ────────────────────────────────────────────────────────────

export type Severity = "low" | "medium" | "high" | "critical";

export interface ToolEvent {
  uid: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  durationMs: number;
  error?: string;
  costUsd?: number;
  args?: string;
  workspaceId?: string;
  timestamp: number;
}

export interface AnomalyAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  toolName: string;
  agentId?: string;
  uid?: string;
  description: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface AnomalyRule {
  id: string;
  name: string;
  description: string;
  check: (event: ToolEvent, detector: ToolAnomalyDetector) => AnomalyAlert | null;
}

// ── Sliding Window State ─────────────────────────────────────────────

interface AgentWindow {
  events: ToolEvent[];
  sessionCost: Map<string, number>;
}

const WINDOW_MS = 5 * 60_000;

// ── Built-in Rules ───────────────────────────────────────────────────

const runawayLoopRule: AnomalyRule = {
  id: "runaway_loop",
  name: "Runaway Tool Loop",
  description: "Same tool called > 30 times in 60s by same agent",
  check(event, detector) {
    const window = detector.getAgentWindow(event.agentId);
    const cutoff = event.timestamp - 60_000;
    const recent = window.events.filter(
      (e) => e.toolName === event.toolName && e.timestamp >= cutoff,
    );

    if (recent.length >= 30) {
      return {
        id: randomUUID(),
        ruleId: "runaway_loop",
        ruleName: "Runaway Tool Loop",
        severity: "critical",
        toolName: event.toolName,
        agentId: event.agentId,
        uid: event.uid,
        description: `Tool "${event.toolName}" invoked ${recent.length} times in 60s by agent ${event.agentId}`,
        metadata: { callCount: recent.length, sessionId: event.sessionId },
        timestamp: event.timestamp,
      };
    }
    return null;
  },
};

const pathTraversalRule: AnomalyRule = {
  id: "path_traversal",
  name: "Path Traversal Attempt",
  description: "File tool arguments contain ../ or absolute paths outside workspace",
  check(event) {
    const FILE_TOOLS = new Set(["file_read", "file_write", "shell_execute"]);
    if (!FILE_TOOLS.has(event.toolName) || !event.args) return null;

    const hasTraversal = /\.\.[/\\]/.test(event.args);
    const hasAbsPath = /^\/(?!tmp\/|workspace\/)/.test(event.args);

    if (hasTraversal || hasAbsPath) {
      return {
        id: randomUUID(),
        ruleId: "path_traversal",
        ruleName: "Path Traversal Attempt",
        severity: "high",
        toolName: event.toolName,
        agentId: event.agentId,
        uid: event.uid,
        description: `Potential path traversal in "${event.toolName}" — ${hasTraversal ? "contains ../" : "absolute path outside workspace"}`,
        metadata: { argsPreview: event.args.slice(0, 500), hasTraversal, hasAbsPath },
        timestamp: event.timestamp,
      };
    }
    return null;
  },
};

const frequencySpikeRule: AnomalyRule = {
  id: "frequency_spike",
  name: "Tool Call Frequency Spike",
  description: "Tool call rate > 3x the rolling 5-minute average",
  check(event, detector) {
    const window = detector.getAgentWindow(event.agentId);
    const fiveMinAgo = event.timestamp - WINDOW_MS;
    const windowEvents = window.events.filter((e) => e.timestamp >= fiveMinAgo);

    if (windowEvents.length < 10) return null;

    const windowDurationMin = Math.max(1, (event.timestamp - windowEvents[0]!.timestamp) / 60_000);
    const avgRate = windowEvents.length / windowDurationMin;
    const last30s = windowEvents.filter((e) => e.timestamp >= event.timestamp - 30_000);
    const recentRate = (last30s.length / 30) * 60;

    if (recentRate > avgRate * 3 && recentRate > 10) {
      return {
        id: randomUUID(),
        ruleId: "frequency_spike",
        ruleName: "Tool Call Frequency Spike",
        severity: "medium",
        toolName: event.toolName,
        agentId: event.agentId,
        uid: event.uid,
        description: `Frequency spike: ${recentRate.toFixed(1)}/min vs ${avgRate.toFixed(1)}/min avg`,
        metadata: { recentRate, avgRate, recentCount: last30s.length },
        timestamp: event.timestamp,
      };
    }
    return null;
  },
};

const costSpikeRule: AnomalyRule = {
  id: "cost_spike",
  name: "Session Cost Spike",
  description: "Cumulative tool cost in session exceeds $1",
  check(event, detector) {
    if (!event.costUsd || event.costUsd <= 0) return null;

    const window = detector.getAgentWindow(event.agentId);
    const prev = window.sessionCost.get(event.sessionId) ?? 0;
    const current = prev + event.costUsd;
    window.sessionCost.set(event.sessionId, current);

    if (current >= 1.0 && prev < 1.0) {
      return {
        id: randomUUID(),
        ruleId: "cost_spike",
        ruleName: "Session Cost Spike",
        severity: "high",
        toolName: event.toolName,
        agentId: event.agentId,
        uid: event.uid,
        description: `Session cost $${current.toFixed(4)} exceeded $1 threshold`,
        metadata: { sessionCostUsd: current, sessionId: event.sessionId },
        timestamp: event.timestamp,
      };
    }
    return null;
  },
};

const errorStormRule: AnomalyRule = {
  id: "error_storm",
  name: "Tool Error Storm",
  description: "Same tool errors > 10 times in 60s",
  check(event, detector) {
    if (!event.error) return null;

    const window = detector.getAgentWindow(event.agentId);
    const cutoff = event.timestamp - 60_000;
    const recentErrors = window.events.filter(
      (e) => e.toolName === event.toolName && e.error && e.timestamp >= cutoff,
    );

    if (recentErrors.length >= 10) {
      return {
        id: randomUUID(),
        ruleId: "error_storm",
        ruleName: "Tool Error Storm",
        severity: "medium",
        toolName: event.toolName,
        agentId: event.agentId,
        uid: event.uid,
        description: `Error storm on "${event.toolName}": ${recentErrors.length} errors in 60s`,
        metadata: { errorCount: recentErrors.length, lastError: event.error },
        timestamp: event.timestamp,
      };
    }
    return null;
  },
};

// ── Detector Class ───────────────────────────────────────────────────

const MAX_ALERTS = 500;
const COOLDOWN_MS = 30_000;

export class ToolAnomalyDetector {
  private rules = new Map<string, AnomalyRule>();
  private agentWindows = new Map<string, AgentWindow>();
  private recentAlerts: AnomalyAlert[] = [];
  private cooldowns = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.rules.set(runawayLoopRule.id, runawayLoopRule);
    this.rules.set(pathTraversalRule.id, pathTraversalRule);
    this.rules.set(frequencySpikeRule.id, frequencySpikeRule);
    this.rules.set(costSpikeRule.id, costSpikeRule);
    this.rules.set(errorStormRule.id, errorStormRule);
  }

  start(): void {
    if (this.unsubscribe) return;

    const bus = getEventBus();
    this.unsubscribe = bus.on("tool.executed", (payload) => {
      this.processEvent({
        uid: payload.uid,
        agentId: payload.agentId,
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        durationMs: payload.durationMs,
        error: payload.error,
        timestamp: payload.timestamp,
      });
    });

    logger.info(`Anomaly detector started with ${this.rules.size} rules`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  processEvent(event: ToolEvent): void {
    this.addToWindow(event);

    for (const rule of this.rules.values()) {
      try {
        const alert = rule.check(event, this);
        if (alert) this.handleAlert(alert);
      } catch (err) {
        logger.warn(`Rule "${rule.id}" error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getAgentWindow(agentId: string): AgentWindow {
    let w = this.agentWindows.get(agentId);
    if (!w) {
      w = { events: [], sessionCost: new Map() };
      this.agentWindows.set(agentId, w);
    }
    return w;
  }

  addRule(rule: AnomalyRule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  getRecentAlerts(limit = 50): AnomalyAlert[] {
    return this.recentAlerts.slice(-limit);
  }

  getRuleIds(): string[] {
    return [...this.rules.keys()];
  }

  // ── Private ────────────────────────────────────────────────────────

  private addToWindow(event: ToolEvent): void {
    const w = this.getAgentWindow(event.agentId);
    w.events.push(event);

    const cutoff = event.timestamp - WINDOW_MS;
    while (w.events.length > 0 && w.events[0]!.timestamp < cutoff) {
      w.events.shift();
    }

    // Prune stale agent windows
    if (this.agentWindows.size > 500) {
      for (const [id, win] of this.agentWindows) {
        if (win.events.length === 0) this.agentWindows.delete(id);
      }
    }
  }

  private handleAlert(alert: AnomalyAlert): void {
    const key = `${alert.ruleId}:${alert.agentId ?? "global"}`;
    const last = this.cooldowns.get(key) ?? 0;
    if (alert.timestamp - last < COOLDOWN_MS) return;
    this.cooldowns.set(key, alert.timestamp);

    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > MAX_ALERTS) {
      this.recentAlerts = this.recentAlerts.slice(-MAX_ALERTS);
    }

    // Emit on event bus
    try {
      const bus = getEventBus();
      (bus as unknown as { emit(name: string, payload: unknown): void }).emit(
        "tool.anomaly",
        { ...alert, timestamp: alert.timestamp },
      );
    } catch { /* never block */ }

    // Persist (fire-and-forget)
    this.persistAlert(alert).catch(() => {});

    logger.warn(`[${alert.severity.toUpperCase()}] ${alert.ruleId}: ${alert.description}`);
  }

  private async persistAlert(alert: AnomalyAlert): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO tool_anomaly_alerts (id, rule_id, severity, tool_name, agent_id, uid, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [alert.id, alert.ruleId, alert.severity, alert.toolName,
       alert.agentId ?? null, alert.uid ?? null, alert.description, JSON.stringify(alert.metadata)],
    );
  }
}

// ── Singleton ────────────────────────────────────────────────────────

let _detector: ToolAnomalyDetector | undefined;

export function startAnomalyDetector(): ToolAnomalyDetector {
  if (!_detector) {
    _detector = new ToolAnomalyDetector();
    _detector.start();
  }
  return _detector;
}

export function getAnomalyDetector(): ToolAnomalyDetector | undefined {
  return _detector;
}
