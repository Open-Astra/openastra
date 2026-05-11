import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Pool Health Monitor ────────────────────────────────────────────
// Periodically checks connection pool health and exposes metrics.
// Tracks: active/idle/waiting connections, query timing, error rates.
// Emits warnings when pool exhaustion is imminent.

const log = createLogger("pool-monitor");

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeCount: number;
  avgQueryMs: number;
  totalQueries: number;
  totalErrors: number;
  uptime: number;
  lastCheck: string;
}

export interface QueryTiming {
  query: string;
  durationMs: number;
  timestamp: number;
  error?: string;
}

class PoolMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private queryTimings: QueryTiming[] = [];
  private totalQueries = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;

  start(intervalMs = 30_000): void {
    this.startedAt = Date.now();
    this.interval = setInterval(() => this.check(), intervalMs);
    log.info(`Pool monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    log.info("Pool monitor stopped");
  }

  recordQuery(timing: QueryTiming): void {
    this.totalQueries++;
    this.totalDurationMs += timing.durationMs;
    if (timing.error) this.totalErrors++;

    this.queryTimings.push(timing);
    if (this.queryTimings.length > 1000) {
      this.queryTimings = this.queryTimings.slice(-500);
    }
  }

  getStats(): PoolStats {
    let pool: ReturnType<typeof getPool>;
    try {
      pool = getPool();
    } catch {
      return {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        activeCount: 0,
        avgQueryMs: 0,
        totalQueries: this.totalQueries,
        totalErrors: this.totalErrors,
        uptime: Date.now() - this.startedAt,
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      activeCount: pool.totalCount - pool.idleCount,
      avgQueryMs: this.totalQueries > 0 ? Math.round(this.totalDurationMs / this.totalQueries) : 0,
      totalQueries: this.totalQueries,
      totalErrors: this.totalErrors,
      uptime: Date.now() - this.startedAt,
      lastCheck: new Date().toISOString(),
    };
  }

  getRecentTimings(limit = 20): QueryTiming[] {
    return this.queryTimings.slice(-limit);
  }

  getSlowQueries(thresholdMs = 1000, limit = 10): QueryTiming[] {
    return this.queryTimings
      .filter((t) => t.durationMs >= thresholdMs)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, limit);
  }

  private check(): void {
    const stats = this.getStats();

    if (stats.waitingCount > 0) {
      log.warn(`Pool pressure: ${stats.waitingCount} queries waiting (${stats.activeCount}/${stats.totalCount} active)`);
    }

    const utilization = stats.totalCount > 0 ? stats.activeCount / stats.totalCount : 0;
    if (utilization > 0.8) {
      log.warn(`Pool utilization at ${Math.round(utilization * 100)}% — consider increasing PG_MAX_CONNECTIONS`);
    }
  }
}

// ── Typed Query Helper ─────────────────────────────────────────────
// Wraps pg queries with automatic timing and type inference.

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number; durationMs: number }> {
  const pool = getPool();
  const monitor = getPoolMonitor();
  const start = Date.now();

  try {
    const result = await pool.query<T>(sql, params);
    const durationMs = Date.now() - start;

    monitor.recordQuery({
      query: sql.slice(0, 200),
      durationMs,
      timestamp: Date.now(),
    });

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? 0,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;

    monitor.recordQuery({
      query: sql.slice(0, 200),
      durationMs,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function execute(sql: string, params?: unknown[]): Promise<number> {
  const result = await query(sql, params);
  return result.rowCount;
}

// ── Transaction Helper ─────────────────────────────────────────────

export async function transaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  const monitor = getPoolMonitor();
  const start = Date.now();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");

    monitor.recordQuery({
      query: "TRANSACTION (committed)",
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    });

    return result;
  } catch (err) {
    await client.query("ROLLBACK");

    monitor.recordQuery({
      query: "TRANSACTION (rolled back)",
      durationMs: Date.now() - start,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  } finally {
    client.release();
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: PoolMonitor | null = null;

export function getPoolMonitor(): PoolMonitor {
  if (!_instance) {
    _instance = new PoolMonitor();
  }
  return _instance;
}
