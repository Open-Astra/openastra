import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("otel-exporter");

// ── OTLP Exporter ────────────────────────────────────────────────────
// Reads trace_spans from Postgres and exports them to an OTLP HTTP
// endpoint using the OpenTelemetry JSON-over-HTTP wire format.

export interface ExportResult {
  exported: number;
  endpoint: string;
  durationMs: number;
}

interface OtelExportConfig {
  workspace_id: string;
  endpoint: string;
  headers: Record<string, string>;
  enabled: boolean;
}

interface SpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  workspace_id: string;
  agent_id: string;
  span_type: string;
  name: string;
  attributes: Record<string, unknown>;
  start_time: string;
  end_time: string | null;
  status: string;
}

function toUnixNano(isoString: string): string {
  return String(new Date(isoString).getTime() * 1_000_000);
}

function statusCode(status: string): number {
  if (status === "ok") return 1;
  if (status === "error") return 2;
  return 0; // unset
}

function spanToOtlp(row: SpanRow) {
  return {
    traceId: row.trace_id,
    spanId: row.id,
    parentSpanId: row.parent_span_id ?? undefined,
    name: row.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: toUnixNano(row.start_time),
    endTimeUnixNano: row.end_time ? toUnixNano(row.end_time) : undefined,
    attributes: Object.entries(row.attributes).map(([key, value]) => ({
      key,
      value: { stringValue: String(value) },
    })),
    status: { code: statusCode(row.status) },
    resource: {
      attributes: [
        { key: "workspace.id", value: { stringValue: row.workspace_id } },
        { key: "agent.id", value: { stringValue: row.agent_id } },
        { key: "astra.span_type", value: { stringValue: row.span_type } },
      ],
    },
  };
}

export async function exportSpansToOtlp(
  workspaceId: string,
  sinceMs: number,
): Promise<ExportResult> {
  const pool = getPool();
  const startedAt = Date.now();

  // Fetch workspace OTLP config
  const configResult = await pool.query<OtelExportConfig>(
    `SELECT workspace_id, endpoint, headers, enabled
     FROM otel_export_configs
     WHERE workspace_id = $1 AND enabled = true`,
    [workspaceId],
  );

  if (configResult.rows.length === 0) {
    return { exported: 0, endpoint: "", durationMs: Date.now() - startedAt };
  }

  const config = configResult.rows[0]!;

  // Fetch spans since the given timestamp
  const sinceIso = new Date(sinceMs).toISOString();
  const spansResult = await pool.query<SpanRow>(
    `SELECT id, trace_id, parent_span_id, workspace_id, agent_id, span_type, name,
            attributes, start_time, end_time, status
     FROM trace_spans
     WHERE workspace_id = $1 AND start_time >= $2
     ORDER BY start_time`,
    [workspaceId, sinceIso],
  );

  if (spansResult.rows.length === 0) {
    return { exported: 0, endpoint: config.endpoint, durationMs: Date.now() - startedAt };
  }

  // Group spans by trace_id
  const byTrace = new Map<string, SpanRow[]>();
  for (const row of spansResult.rows) {
    const existing = byTrace.get(row.trace_id) ?? [];
    existing.push(row);
    byTrace.set(row.trace_id, existing);
  }

  // Build OTLP resourceSpans payload
  const resourceSpans = Array.from(byTrace.values()).map((spans) => ({
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "astra" } },
        { key: "workspace.id", value: { stringValue: workspaceId } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: "astra.tracer", version: "1.0" },
        spans: spans.map(spanToOtlp),
      },
    ],
  }));

  const otlpPayload = { resourceSpans };

  // Build headers
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.headers,
  };

  // POST to OTLP endpoint
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(`${config.endpoint}/v1/traces`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(otlpPayload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.error(`OTLP export failed: HTTP ${response.status} — ${body}`);
      return {
        exported: 0,
        endpoint: config.endpoint,
        durationMs: Date.now() - startedAt,
      };
    }
  } catch (err) {
    log.error("OTLP export request error:", err);
    return { exported: 0, endpoint: config.endpoint, durationMs: Date.now() - startedAt };
  }

  return {
    exported: spansResult.rows.length,
    endpoint: config.endpoint,
    durationMs: Date.now() - startedAt,
  };
}
