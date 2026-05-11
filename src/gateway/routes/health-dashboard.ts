import { Router, type Request, type Response } from "express";
import { getPool, pingPostgres } from "../../config/postgres.js";
import { getTypesense } from "../../config/typesense.js";
import { getAllCircuitBreakerStates } from "../../inference/circuit-breaker.js";
import { getEventBus } from "../../events/index.js";
import { createLogger } from "../../utils/logger.js";

// ── Health Dashboard ──────────────────────────────────────────────────
// Comprehensive health endpoint aggregating status from all services.
// No auth required — intended for load balancers and monitoring systems.

const log = createLogger("health-dashboard");
const startedAt = Date.now();

interface ServiceStatus {
  status: "up" | "down" | "degraded";
  latencyMs: number;
}

interface PostgresStatus extends ServiceStatus {
  poolStats: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
}

interface TypesenseStatus extends ServiceStatus {
  isDegraded: boolean;
}

interface InferenceProviderStatus {
  status: "up" | "down" | "degraded";
  circuitState: string;
  latencyMs: number;
}

interface JobQueueStatus extends ServiceStatus {
  pendingJobs: number;
  failedJobs: number;
}

interface EventBusStatus extends ServiceStatus {
  listenerCount: number;
}

interface HealthDashboardResponse {
  status: "healthy" | "degraded" | "unhealthy";
  services: {
    postgres: PostgresStatus;
    typesense: TypesenseStatus;
    inference: { providers: Record<string, InferenceProviderStatus> };
    eventBus: EventBusStatus;
    jobQueue: JobQueueStatus;
  };
  uptime: number;
  version: string;
}

async function checkPostgres(): Promise<PostgresStatus> {
  const start = Date.now();
  try {
    const pool = getPool();
    const ok = await pingPostgres();
    const latencyMs = Date.now() - start;
    return {
      status: ok ? "up" : "down",
      latencyMs,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
    };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      poolStats: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    };
  }
}

async function checkTypesense(): Promise<TypesenseStatus> {
  const start = Date.now();
  try {
    const client = getTypesense();
    await client.health.retrieve();
    return {
      status: "up",
      latencyMs: Date.now() - start,
      isDegraded: false,
    };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      isDegraded: true,
    };
  }
}

function checkInference(): { providers: Record<string, InferenceProviderStatus> } {
  const states = getAllCircuitBreakerStates();
  const providers: Record<string, InferenceProviderStatus> = {};

  for (const [name, state] of Object.entries(states)) {
    let status: "up" | "down" | "degraded" = "up";
    if (state.state === "open") status = "down";
    else if (state.state === "half-open") status = "degraded";

    providers[name] = {
      status,
      circuitState: state.state,
      latencyMs: state.p50Ms ?? 0,
    };
  }

  return { providers };
}

function checkEventBus(): EventBusStatus {
  try {
    const bus = getEventBus();
    // Use wildcard listener count as a proxy for total active listeners
    const count = bus.listenerCount("*" as Parameters<typeof bus.listenerCount>[0]);
    return { status: "up", latencyMs: 0, listenerCount: count };
  } catch {
    return { status: "down", latencyMs: 0, listenerCount: 0 };
  }
}

async function checkJobQueue(): Promise<JobQueueStatus> {
  const start = Date.now();
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
       FROM job_queue`,
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      status: "up",
      latencyMs: Date.now() - start,
      pendingJobs: row.pending as number,
      failedJobs: row.failed as number,
    };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      pendingJobs: 0,
      failedJobs: 0,
    };
  }
}

export function createHealthDashboardRouter(): Router {
  const router = Router();

  router.get("/dashboard", async (_req: Request, res: Response) => {
    try {
      const [postgres, typesense, jobQueue] = await Promise.all([
        checkPostgres(),
        checkTypesense(),
        checkJobQueue(),
      ]);

      const inference = checkInference();
      const eventBus = checkEventBus();

      // Determine overall status
      const serviceStatuses = [postgres.status, typesense.status, jobQueue.status, eventBus.status];

      // Add inference provider statuses
      for (const provider of Object.values(inference.providers)) {
        serviceStatuses.push(provider.status);
      }

      let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
      if (serviceStatuses.includes("down")) {
        // If postgres is down, it's unhealthy; otherwise degraded
        overallStatus = postgres.status === "down" ? "unhealthy" : "degraded";
      } else if (serviceStatuses.includes("degraded")) {
        overallStatus = "degraded";
      }

      const response: HealthDashboardResponse = {
        status: overallStatus,
        services: {
          postgres,
          typesense,
          inference,
          eventBus,
          jobQueue,
        },
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        version: process.env.npm_package_version ?? "0.0.0",
      };

      const httpStatus = overallStatus === "unhealthy" ? 503 : 200;
      res.status(httpStatus).json(response);
    } catch (err) {
      log.error("Health dashboard error:", err);
      res.status(500).json({
        status: "unhealthy",
        error: "Failed to collect health data",
      });
    }
  });

  return router;
}
