// ── GDPR Right-to-Erasure ────────────────────────────────────────────
// Hard-delete all data for a user across every table that holds it.
//
// The schema has ~280 tables and grows with every migration, so the set of
// tables is DISCOVERED from information_schema rather than hard-coded: any
// table with a `uid` / `user_id` column (or a `session_id` column pointing at
// one of the user's sessions) is covered automatically, with the real column
// names. Everything runs in one transaction on one client; any failure rolls
// the whole erasure back and is surfaced to the caller.

import { createHash } from "node:crypto";
import type pg from "pg";
import { getPool } from "../config/postgres.js";
import { getTypesense } from "../config/typesense.js";
import { uidFilter } from "../memory/ts-filter.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("gdpr-erasure");

export interface ErasureResult {
  userId: string;
  /** null = every workspace (full erasure). */
  workspaceId: string | null;
  deletedAt: Date;
  /** Rows deleted per Postgres table (only tables with > 0 rows). */
  counts: Record<string, number>;
  /** Rows anonymized (kept for legal/audit retention, user id replaced). */
  anonymized: Record<string, number>;
  /** Documents deleted per Typesense collection. */
  typesense: Record<string, number>;
  /** Tables deliberately left untouched, with the reason. */
  retained: Array<{ table: string; reason: string }>;
  /** Stores that cannot be erased in-line and need operator follow-up. */
  notes: string[];
}

export class ErasureIncompleteError extends Error {
  constructor(message: string, public partial: ErasureResult) {
    super(message);
    this.name = "ErasureIncompleteError";
  }
}

// Account / membership / financial records are not "memory"; deleting the
// account itself is a separate, explicit operation.
const RETAIN_TABLES: Record<string, string> = {
  users: "account record (delete the account separately)",
  workspaces: "workspace record",
  workspace_members: "workspace membership",
  schema_migrations: "system table",
};
const RETAIN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^(billing|invoice|license|payment)/, reason: "financial record (legal retention)" },
  { re: /^audit_ledger/, reason: "append-only tamper-evident ledger (legal retention; rows cannot be modified)" },
];

// Audit trails are anonymized rather than deleted where the schema allows it.
const AUDIT_PATTERN = /audit/;

const USER_COLUMNS = ["uid", "user_id"] as const;
const TYPESENSE_COLLECTIONS = ["memory_chunks", "procedural_memory", "knowledge_store"];

interface TableInfo {
  userColumns: string[];
  hasWorkspace: boolean;
  hasSession: boolean;
}

function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function isAllWorkspaces(workspaceId: string | null | undefined): boolean {
  return workspaceId === null || workspaceId === undefined || workspaceId === "" || workspaceId === "default";
}

async function discoverTables(client: pg.PoolClient): Promise<Map<string, TableInfo>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.column_name IN ('uid', 'user_id', 'workspace_id', 'session_id')`,
  );
  const tables = new Map<string, TableInfo>();
  for (const row of rows) {
    let info = tables.get(row.table_name);
    if (!info) {
      info = { userColumns: [], hasWorkspace: false, hasSession: false };
      tables.set(row.table_name, info);
    }
    if ((USER_COLUMNS as readonly string[]).includes(row.column_name)) info.userColumns.push(row.column_name);
    else if (row.column_name === "workspace_id") info.hasWorkspace = true;
    else if (row.column_name === "session_id") info.hasSession = true;
  }
  return tables;
}

interface Statement {
  table: string;
  kind: "delete" | "anonymize";
  sql: string;
  params: unknown[];
  /** Used when an anonymizing UPDATE is impossible (e.g. FK to users). */
  fallback?: { sql: string; params: unknown[] };
}

/**
 * Permanently erase a user's data.
 *
 * @param workspaceId - a workspace id restricts erasure to rows of that
 *   workspace (tables with no workspace column are then only touched through
 *   the user's sessions in that workspace, and otherwise reported as retained).
 *   null / "" / "default" erases the user's data in EVERY workspace.
 *
 * Irreversible. The caller must verify authorization first.
 * Throws on any Postgres failure (transaction rolled back) and throws
 * ErasureIncompleteError if Postgres succeeded but the search index did not.
 */
export async function eraseUserData(
  userId: string,
  workspaceId: string | null,
): Promise<ErasureResult> {
  if (!userId) throw new Error("eraseUserData: userId is required");

  const all = isAllWorkspaces(workspaceId);
  const ws = all ? null : (workspaceId as string);
  logger.warn(`GDPR erasure requested for user=${userId} workspace=${ws ?? "*"}`);

  const result: ErasureResult = {
    userId,
    workspaceId: ws,
    deletedAt: new Date(),
    counts: {},
    anonymized: {},
    typesense: {},
    retained: [],
    notes: [],
  };

  const anonymizedUid = "gdpr_erased_" + createHash("sha256").update(userId).digest("hex").slice(0, 16);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '300s'");

    const tables = await discoverTables(client);

    // The user's sessions (in scope) — used to reach tables keyed by session only.
    let sessionIds: string[] = [];
    const sessions = tables.get("sessions");
    if (sessions && sessions.userColumns.length > 0) {
      const col = q(sessions.userColumns[0]!);
      const { rows } = all || !sessions.hasWorkspace
        ? await client.query<{ id: string }>(
            `SELECT id::text AS id FROM sessions WHERE ${col}::text = $1`, [userId])
        : await client.query<{ id: string }>(
            `SELECT id::text AS id FROM sessions WHERE ${col}::text = $1 AND workspace_id::text = $2`,
            [userId, ws]);
      sessionIds = rows.map((r) => r.id);
    }

    const statements: Statement[] = [];
    const deferred: Statement[] = []; // sessions last, so children go first

    for (const [table, info] of tables) {
      const retainReason = RETAIN_TABLES[table] ?? RETAIN_PATTERNS.find((p) => p.re.test(table))?.reason;
      if (retainReason) {
        if (info.userColumns.length > 0) result.retained.push({ table, reason: retainReason });
        continue;
      }

      if (info.userColumns.length === 0) {
        // No user column: reachable only through the user's sessions.
        if (info.hasSession && sessionIds.length > 0) {
          statements.push({
            table,
            kind: "delete",
            sql: `DELETE FROM ${q(table)} WHERE session_id::text = ANY($1::text[])`,
            params: [sessionIds],
          });
        }
        continue;
      }

      const userPred = info.userColumns.map((c) => `${q(c)}::text = $1`).join(" OR ");
      let where: string;
      let params: unknown[];

      if (all) {
        where = `(${userPred})`;
        params = [userId];
      } else if (info.hasWorkspace) {
        where = `(${userPred}) AND workspace_id::text = $2`;
        params = [userId, ws];
      } else if (info.hasSession && sessionIds.length > 0) {
        where = `(${userPred}) AND session_id::text = ANY($2::text[])`;
        params = [userId, sessionIds];
      } else {
        result.retained.push({
          table,
          reason: "no workspace column — erased only by a full (all-workspace) erasure",
        });
        continue;
      }

      const del = { sql: `DELETE FROM ${q(table)} WHERE ${where}`, params };
      let stmt: Statement;
      if (AUDIT_PATTERN.test(table)) {
        const sets = info.userColumns.map((c) => `${q(c)} = $${params.length + 1}`).join(", ");
        stmt = {
          table,
          kind: "anonymize",
          sql: `UPDATE ${q(table)} SET ${sets} WHERE ${where}`,
          params: [...params, anonymizedUid],
          fallback: del,
        };
      } else {
        stmt = { table, kind: "delete", ...del };
      }
      (table === "sessions" ? deferred : statements).push(stmt);
    }

    // Unattributed legacy semantic-cache rows (written before entries carried
    // a uid) may contain this user's answers; it is only a cache, so drop them.
    if (tables.has("semantic_cache") && tables.get("semantic_cache")!.userColumns.includes("uid")) {
      statements.push({
        table: "semantic_cache",
        kind: "delete",
        sql: `DELETE FROM semantic_cache WHERE uid IS NULL`,
        params: [],
      });
    }

    // Foreign keys between user tables are not known up front, so run each
    // statement in a savepoint and retry the ones blocked by a dependency.
    let pending = [...statements, ...deferred];
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      const blocked: Statement[] = [];
      let lastErr: unknown;
      for (const stmt of pending) {
        await client.query("SAVEPOINT erase_stmt");
        try {
          const res = await client.query(stmt.sql, stmt.params);
          await client.query("RELEASE SAVEPOINT erase_stmt");
          const n = res.rowCount ?? 0;
          if (n > 0) {
            const bucket = stmt.kind === "anonymize" ? result.anonymized : result.counts;
            bucket[stmt.table] = (bucket[stmt.table] ?? 0) + n;
          }
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT erase_stmt");
          lastErr = err;
          const code = (err as { code?: string }).code;
          if (stmt.kind === "anonymize" && stmt.fallback) {
            // e.g. audit_log.user_id REFERENCES users(id): cannot hold a
            // pseudonym, so the rows are deleted instead.
            blocked.push({ table: stmt.table, kind: "delete", ...stmt.fallback });
          } else if (code === "23503" || code === "23001") {
            blocked.push(stmt); // FK dependency — retry after the others
          } else {
            throw new Error(
              `GDPR erasure failed on table "${stmt.table}": ${(err as Error).message}`,
              { cause: err },
            );
          }
        }
      }
      if (blocked.length === pending.length && blocked.every((b, i) => b === pending[i])) {
        throw new Error(
          `GDPR erasure blocked by foreign keys on: ${blocked.map((b) => b.table).join(", ")} — ` +
          `${(lastErr as Error | undefined)?.message ?? "unknown error"}`,
          { cause: lastErr },
        );
      }
      pending = blocked;
    }
    if (pending.length > 0) {
      throw new Error(`GDPR erasure could not complete for: ${pending.map((b) => b.table).join(", ")}`);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(`GDPR erasure rolled back for user=${userId}: ${(err as Error).message}`);
    throw err;
  } finally {
    client.release();
  }

  // ── Search index (outside the SQL transaction) ─────────────────────
  // Typesense documents carry a uid but no workspace, so they can only be
  // removed by a full erasure.
  const tsErrors: string[] = [];
  if (all) {
    let ts: ReturnType<typeof getTypesense> | undefined;
    try {
      ts = getTypesense();
    } catch {
      result.notes.push("Typesense is not initialised in this process — search index not purged");
    }
    if (ts) {
      for (const collection of TYPESENSE_COLLECTIONS) {
        try {
          const res = await ts.collections(collection).documents().delete({ filter_by: uidFilter(userId) });
          result.typesense[collection] = (res as { num_deleted?: number }).num_deleted ?? 0;
        } catch (err) {
          const status = (err as { httpStatus?: number }).httpStatus;
          if (status === 404) continue; // collection does not exist in this deployment
          tsErrors.push(`${collection}: ${(err as Error).message}`);
        }
      }
    }
  } else {
    result.notes.push("Search index (Typesense) is keyed by user only — purged by a full erasure, not a workspace-scoped one");
  }

  result.notes.push(
    "Cold-store snapshots taken before this erasure still contain the user's data until they expire — " +
    "delete or re-snapshot per your retention policy",
  );

  logger.warn(
    `GDPR erasure complete for user=${userId}: deleted=${JSON.stringify(result.counts)} ` +
    `anonymized=${JSON.stringify(result.anonymized)} typesense=${JSON.stringify(result.typesense)}`,
  );

  if (tsErrors.length > 0) {
    throw new ErasureIncompleteError(
      `Postgres data erased but the search index purge failed (${tsErrors.join("; ")}). Re-run the erasure.`,
      result,
    );
  }

  return result;
}
