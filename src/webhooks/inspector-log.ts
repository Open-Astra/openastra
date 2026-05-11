import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

// ── Webhook Inspector Log ─────────────────────────────────────────────
// Fire-and-forget INSERT into webhook_log after each outbound dispatch.
// workspace_id is stored as the webhook owner's uid (webhooks are
// currently user-scoped; the inspector route filters by workspace_id
// from the X-Workspace-Id header, so this log uses uid as the key).

export interface InspectorLogEntry {
  workspaceId: string;       // uid of the webhook owner (workspace key)
  webhookUrl: string;
  eventType: string;
  payload: Record<string, unknown>;
  responseStatus?: number;
  responseBody?: string;
  durationMs: number;
}

export function logWebhookDispatch(entry: InspectorLogEntry): void {
  const id = randomUUID();
  getPool()
    .query(
      `INSERT INTO webhook_log
         (id, workspace_id, webhook_url, event_type, payload,
          response_status, response_body, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        id,
        entry.workspaceId,
        entry.webhookUrl,
        entry.eventType,
        JSON.stringify(entry.payload),
        entry.responseStatus ?? null,
        entry.responseBody?.slice(0, 1000) ?? null,
        entry.durationMs,
      ],
    )
    .catch(() => {
      // fire-and-forget — never throw
    });
}
