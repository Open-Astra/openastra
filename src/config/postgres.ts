import pg from "pg";
import { createLogger } from "../utils/logger.js";

const log = createLogger("postgres");

// ── Cloud SQL PostgreSQL Connection ─────────────────────────────────
// Single connection pool for the graph memory layer.
// Supports both direct TCP (dev) and Unix socket (Cloud SQL Proxy on Cloud Run).
//
// Cloud Run auto-injects the socket at /cloudsql/<INSTANCE_CONNECTION_NAME>
// so for production, set PG_HOST to the instance connection name and
// PG_USE_SOCKET=true.

let pool: pg.Pool | undefined;

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  useSocket: boolean;              // true = Cloud SQL Unix socket
  instanceConnectionName?: string; // e.g. project:region:instance
  maxConnections: number;
}

export function loadPostgresConfig(): PostgresConfig {
  return {
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432", 10),
    database: process.env.PG_DATABASE || "astra",
    user: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD || "",
    useSocket: process.env.PG_USE_SOCKET === "true",
    instanceConnectionName: process.env.PG_INSTANCE_CONNECTION_NAME,
    maxConnections: parseInt(process.env.PG_MAX_CONNECTIONS || "10", 10),
  };
}

export function initPostgres(config?: PostgresConfig): pg.Pool {
  if (pool) return pool;

  const cfg = config ?? loadPostgresConfig();

  const poolConfig: pg.PoolConfig = {
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000, // 30s — prevent runaway queries
  };

  if (cfg.useSocket && cfg.instanceConnectionName) {
    // Cloud SQL Unix socket (Cloud Run)
    poolConfig.host = `/cloudsql/${cfg.instanceConnectionName}`;
  } else {
    // Direct TCP (local dev / Cloud SQL Proxy)
    poolConfig.host = cfg.host;
    poolConfig.port = cfg.port;
  }

  pool = new pg.Pool(poolConfig);

  pool.on("error", (err) => {
    log.error("Unexpected pool error:", err.message);
  });

  log.active("Pool initialized", `${cfg.database}@${cfg.useSocket ? "socket" : `${cfg.host}:${cfg.port}`} (max ${cfg.maxConnections})`);

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("PostgreSQL not initialized — call initPostgres() first");
  return pool;
}


export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    log.dim("Pool closed");
  }
}

// ── Health Check ────────────────────────────────────────────────────

export async function pingPostgres(): Promise<boolean> {
  try {
    const p = getPool();
    const result = await p.query("SELECT 1");
    return result.rowCount === 1;
  } catch {
    return false;
  }
}
