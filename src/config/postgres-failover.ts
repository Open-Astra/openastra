import { Pool, type PoolConfig } from "pg";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pg-failover");

export class FailoverPool {
  private primary: Pool;
  private standby: Pool | null;
  private usingStandby = false;
  private failoverAt: Date | null = null;

  constructor(primaryConfig: PoolConfig, standbyConfig?: PoolConfig) {
    this.primary = new Pool(primaryConfig);
    this.standby = standbyConfig ? new Pool(standbyConfig) : null;
  }

  get current(): Pool {
    return this.usingStandby && this.standby ? this.standby : this.primary;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    ...args: Parameters<Pool["query"]>
  ): Promise<import("pg").QueryResult<T>> {
    try {
      return await (this.current.query as (...a: Parameters<Pool["query"]>) => Promise<import("pg").QueryResult<T>>)(...args);
    } catch (err: unknown) {
      if (!this.usingStandby && this.standby) {
        log.error("Primary DB error, failing over to standby:", err);
        this.usingStandby = true;
        this.failoverAt = new Date();
        return await (this.standby.query as (...a: Parameters<Pool["query"]>) => Promise<import("pg").QueryResult<T>>)(...args);
      }
      throw err;
    }
  }

  getCurrentRegion(): string {
    return this.usingStandby ? "standby" : "primary";
  }

  async failover(): Promise<void> {
    if (!this.standby) throw new Error("No standby configured");
    this.usingStandby = true;
    this.failoverAt = new Date();
    log.warn("Manual failover to standby DB");
  }

  async recover(): Promise<void> {
    this.usingStandby = false;
    this.failoverAt = null;
    log.info("Recovered to primary DB");
  }

  getStatus(): { region: string; failoverAt: Date | null } {
    return { region: this.getCurrentRegion(), failoverAt: this.failoverAt };
  }

  async end(): Promise<void> {
    await this.primary.end();
    await this.standby?.end();
  }
}

// ── Singleton failover pool instance ─────────────────────────────────
// Initialized lazily from environment variables. The failover routes
// manage this instance directly without modifying postgres.ts.

let _failoverPool: FailoverPool | null = null;

export function getFailoverPool(): FailoverPool {
  if (!_failoverPool) {
    const primaryConfig: PoolConfig = {
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432", 10),
      database: process.env.PG_DATABASE || "astra",
      user: process.env.PG_USER || "postgres",
      password: process.env.PG_PASSWORD || "",
    };

    const standbyHost = process.env.PG_STANDBY_HOST;
    const standbyConfig: PoolConfig | undefined = standbyHost
      ? {
          host: standbyHost,
          port: parseInt(process.env.PG_STANDBY_PORT || process.env.PG_PORT || "5432", 10),
          database: process.env.PG_DATABASE || "astra",
          user: process.env.PG_USER || "postgres",
          password: process.env.PG_PASSWORD || "",
        }
      : undefined;

    _failoverPool = new FailoverPool(primaryConfig, standbyConfig);
  }
  return _failoverPool;
}
