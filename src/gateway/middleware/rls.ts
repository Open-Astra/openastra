// ── Row-Level Security Context Middleware ─────────────────────────────
// Acquires a dedicated Postgres client per request, opens a transaction,
// and calls set_rls_context(uid, workspace_id) so that RLS policies
// defined in migration 040 are properly enforced.
//
// Must run AFTER jwtAuth() and workspaceResolver().
//
// Downstream route handlers should call getRlsClient(req) to get the
// RLS-scoped client. If the middleware didn't run (e.g., public routes),
// getRlsClient falls back to pool.query().

import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import { getPool } from "../../config/postgres.js";
import type { AuthenticatedRequest } from "./auth.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("rls");

const RLS_CLIENT_KEY = Symbol("rlsClient");

/**
 * Middleware that acquires a per-request Postgres client in a transaction
 * with RLS session variables set. The client is committed and released
 * when the response finishes.
 */
export function rlsContext() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as unknown as AuthenticatedRequest;
    const uid = authReq.uid ?? "";
    const workspaceId = (authReq as unknown as Record<string, unknown>).workspaceId as string ?? "";

    let client: PoolClient | undefined;

    try {
      const pool = getPool();
      client = await pool.connect();

      // Start a transaction so SET LOCAL scopes to this request only
      await client.query("BEGIN");
      await client.query("SELECT set_rls_context($1, $2)", [uid, workspaceId]);

      // Attach the client to the request
      (req as unknown as Record<symbol, unknown>)[RLS_CLIENT_KEY] = client;

      // Clean up when the response finishes
      const cleanup = async () => {
        if (!client) return;
        try {
          await client.query("COMMIT");
        } catch {
          try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        } finally {
          client.release();
          client = undefined;
        }
      };

      res.on("finish", cleanup);
      res.on("close", cleanup);

      next();
    } catch (err) {
      // If RLS setup fails (migration not run, pool exhausted, etc.),
      // release the client and continue without RLS.
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        client.release();
      }
      log.dim("RLS context setup failed — continuing without RLS");
      next();
    }
  };
}

/**
 * Get the RLS-scoped Postgres client from the request.
 * Falls back to pool.query() if the RLS middleware didn't run.
 */
export function getRlsClient(req: Request): PoolClient | ReturnType<typeof getPool> {
  const client = (req as unknown as Record<symbol, unknown>)[RLS_CLIENT_KEY] as PoolClient | undefined;
  return client ?? getPool();
}
