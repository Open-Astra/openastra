import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getPool } from "../../config/postgres.js";
import { createLogger } from "../../utils/logger.js";
import type { WorkspaceAwareRequest } from "./workspace.js";

// ── Resource Ownership Guard ────────────────────────────────────────
// Routes that address a resource by bare id (/things/:id) must prove the
// resource belongs to the caller's workspace before touching it —
// otherwise any tenant can read or mutate another tenant's rows by
// guessing ids (IDOR). Queries are fixed strings chosen from this map;
// no identifier is ever interpolated from request data.

const log = createLogger("ownership");

const OWNERSHIP_QUERIES = {
  workQueue: "SELECT 1 FROM work_queues WHERE id = $1 AND workspace_id = $2",
  workQueueTask:
    `SELECT 1 FROM work_queue_tasks t
       JOIN work_queues q ON q.id = t.queue_id
      WHERE t.id = $1 AND q.workspace_id = $2`,
  escalationChain: "SELECT 1 FROM escalation_chains WHERE id = $1 AND workspace_id = $2",
  escalationEvent: "SELECT 1 FROM escalation_events WHERE id = $1 AND workspace_id = $2",
  vectorExportJob: "SELECT 1 FROM vector_export_jobs WHERE id = $1 AND workspace_id = $2",
  teamKbEntry: "SELECT 1 FROM team_kb_entries WHERE id = $1 AND workspace_id = $2",
  teamChannel: "SELECT 1 FROM team_topic_channels WHERE id = $1 AND workspace_id = $2",
  mentorshipPair: "SELECT 1 FROM mentorship_pairs WHERE id = $1 AND workspace_id = $2",
  consensusRound: "SELECT 1 FROM consensus_rounds WHERE id = $1 AND workspace_id = $2",
  pairSession: "SELECT 1 FROM pair_sessions WHERE id = $1 AND workspace_id = $2",
  taskGraphNode: "SELECT 1 FROM task_graph_nodes WHERE id = $1 AND workspace_id = $2",
} as const;

export type OwnedResource = keyof typeof OWNERSHIP_QUERIES;

export async function belongsToWorkspace(
  kind: OwnedResource,
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await getPool().query(OWNERSHIP_QUERIES[kind], [id, workspaceId]);
  return rows.length > 0;
}

/**
 * Middleware: 400 without a workspace, 404 unless `req.params[param]`
 * names a resource owned by that workspace. 404 (not 403) so ids from
 * other tenants cannot be probed. Fails closed on lookup errors.
 */
export function requireOwned(kind: OwnedResource, param = "id"): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }
    const id = req.params[param];
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    try {
      // Several of these tables use UUID primary keys — a malformed id
      // would raise a cast error in Postgres rather than simply not match.
      if (!/^[A-Za-z0-9_:.-]+$/.test(id)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (!(await belongsToWorkspace(kind, id, workspaceId))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      next();
    } catch (err) {
      log.error(`Ownership check failed (${kind}):`, err);
      res.status(503).json({ error: "Ownership check failed" });
    }
  };
}
