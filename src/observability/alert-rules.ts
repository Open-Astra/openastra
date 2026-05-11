// ── Alert Rules Engine ───────────────────────────────────────────────
// User-defined thresholds that fire webhooks when metrics cross limits.

import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("alert-rules");

export type AlertMetric = "cost_usd" | "error_rate" | "latency_p99_ms" | "token_count";
export type AlertOperator = "gt" | "lt" | "gte" | "lte";

export interface AlertRule {
  id: string;
  workspaceId: string;
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  webhookUrl?: string | null;
  emailTo?: string[] | null;
  enabled: boolean;
  lastFiredAt?: Date | null;
}

export interface AlertFiring {
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  currentValue: number;
  threshold: number;
  operator: AlertOperator;
  firedAt: Date;
}

function compare(value: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
  }
}

async function queryMetric(
  metric: AlertMetric,
  workspaceId: string,
  windowMinutes: number,
): Promise<number> {
  const pool = getPool();
  const sinceMs = Date.now() - windowMinutes * 60 * 1000;

  switch (metric) {
    case "token_count": {
      const { rows } = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM((metadata->>'totalTokens')::int), 0) AS total
         FROM audit_log
         WHERE event = 'inference.request'
           AND workspace_id::text = $1
           AND timestamp::bigint > $2`,
        [workspaceId, sinceMs],
      );
      return parseInt(rows[0]?.total ?? "0", 10);
    }
    case "latency_p99_ms": {
      const { rows } = await pool.query<{ p99: string }>(
        `SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (metadata->>'durationMs')::int) AS p99
         FROM audit_log
         WHERE event = 'inference.request'
           AND workspace_id::text = $1
           AND timestamp::bigint > $2`,
        [workspaceId, sinceMs],
      );
      return parseFloat(rows[0]?.p99 ?? "0");
    }
    case "error_rate": {
      const { rows } = await pool.query<{ total: string; errors: string }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN metadata->>'error' IS NOT NULL THEN 1 ELSE 0 END) AS errors
         FROM audit_log
         WHERE event IN ('tool.executed', 'inference.request')
           AND workspace_id::text = $1
           AND timestamp::bigint > $2`,
        [workspaceId, sinceMs],
      );
      const total = parseInt(rows[0]?.total ?? "0", 10);
      if (total === 0) return 0;
      return parseInt(rows[0]?.errors ?? "0", 10) / total;
    }
    case "cost_usd": {
      // Approximate: read from billing_usage if it exists
      try {
        const { rows } = await pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM billing_usage
           WHERE workspace_id = $1 AND recorded_at > NOW() - INTERVAL '1 minute' * $2`,
          [workspaceId, windowMinutes],
        );
        return parseFloat(rows[0]?.total ?? "0");
      } catch {
        return 0;
      }
    }
  }
}

export async function evaluateAlertRules(workspaceId?: string): Promise<AlertFiring[]> {
  const pool = getPool();
  const firings: AlertFiring[] = [];

  const { rows: rules } = await pool.query<AlertRule>(
    `SELECT id, workspace_id AS "workspaceId", name, metric, operator, threshold,
            window_minutes AS "windowMinutes", webhook_url AS "webhookUrl",
            email_to AS "emailTo", enabled, last_fired_at AS "lastFiredAt"
     FROM alert_rules
     WHERE enabled = true ${workspaceId ? "AND workspace_id = $1" : ""}`,
    workspaceId ? [workspaceId] : [],
  );

  for (const rule of rules) {
    try {
      const value = await queryMetric(rule.metric, rule.workspaceId, rule.windowMinutes);
      if (compare(value, rule.operator, rule.threshold)) {
        firings.push({
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          currentValue: value,
          threshold: rule.threshold,
          operator: rule.operator,
          firedAt: new Date(),
        });
      }
    } catch (err) {
      logger.warn(`Alert rule ${rule.id} evaluation failed: ${err}`);
    }
  }

  return firings;
}

export async function dispatchAlertFirings(firings: AlertFiring[]): Promise<void> {
  const pool = getPool();

  for (const firing of firings) {
    logger.warn(`Alert firing: rule="${firing.ruleName}" metric=${firing.metric} value=${firing.currentValue} op=${firing.operator} threshold=${firing.threshold}`);

    // Fetch rule for webhook
    const { rows } = await pool.query<{ webhook_url: string | null }>(
      `SELECT webhook_url FROM alert_rules WHERE id = $1`,
      [firing.ruleId],
    );
    const webhookUrl = rows[0]?.webhook_url;

    if (webhookUrl) {
      try {
        if (await isBlockedUrl(webhookUrl)) continue;
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...firing, firedAt: firing.firedAt.toISOString() }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        logger.warn(`Alert webhook dispatch failed for rule ${firing.ruleId}: ${err}`);
      }
    }

    // Update last_fired_at
    await pool.query(
      `UPDATE alert_rules SET last_fired_at = NOW() WHERE id = $1`,
      [firing.ruleId],
    ).catch(() => {});
  }
}
