// ── Read Replica Pool ────────────────────────────────────────────────
// Provides a read replica pool that routes SELECT queries to a standby instance.
// Falls back to primary pool if replica is not configured or fails.

import pg from "pg";
const { Pool } = pg;
import { getPool } from "./postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("postgres-replica");

let replicaPool: pg.Pool | null = null;

export interface ReplicaConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Initialize the read replica pool.
 * Call this after initPostgres() if PG_REPLICA_HOST is set.
 */
export function initReplicaPool(config: ReplicaConfig): void {
  replicaPool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  replicaPool.on("error", (err) => {
    log.error("Replica pool error:", err.message);
  });

  log.active("Replica pool initialized", `${config.database}@${config.host}:${config.port} (max 5)`);
}

/**
 * Returns the read replica pool if available, otherwise the primary pool.
 * Use this for SELECT-only operations that can tolerate replication lag.
 */
export function getReadPool(): pg.Pool {
  return replicaPool ?? getPool();
}

/**
 * Execute a read-only query against the replica (or primary as fallback).
 * If the replica query fails, automatically retries against the primary.
 */
export async function queryReplica<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  if (replicaPool) {
    try {
      return await replicaPool.query<T>(sql, params);
    } catch (err) {
      log.warn("Replica query failed, falling back to primary:", err instanceof Error ? err.message : String(err));
    }
  }
  return getPool().query<T>(sql, params);
}

/**
 * Close the replica pool during graceful shutdown.
 */
export async function closeReplicaPool(): Promise<void> {
  if (replicaPool) {
    await replicaPool.end();
    replicaPool = null;
    log.dim("Replica pool closed");
  }
}
