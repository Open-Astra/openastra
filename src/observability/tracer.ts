import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("span-tracer");

export type SpanType = "agent_turn" | "tool_call" | "inference" | "spawn";

export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  workspaceId: string;
  agentId: string;
  spanType: SpanType;
  name: string;
  attributes: Record<string, unknown>;
  startTime: Date;
  status: string;
}

export class SpanTracer {
  constructor(
    private workspaceId: string,
    private agentId: string,
    private traceId: string,
  ) {}

  startSpan(name: string, type: SpanType, parentSpanId?: string): string {
    const spanId = randomUUID();
    // Fire-and-forget INSERT
    getPool().query(
      `INSERT INTO trace_spans (id, trace_id, parent_span_id, workspace_id, agent_id, span_type, name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')`,
      [spanId, this.traceId, parentSpanId ?? null, this.workspaceId, this.agentId, type, name],
    ).catch((err: unknown) => {
      log.error("Failed to insert span:", err);
    });
    return spanId;
  }

  endSpan(spanId: string, status = "ok"): void {
    getPool().query(
      `UPDATE trace_spans SET end_time = NOW(), status = $1 WHERE id = $2`,
      [status, spanId],
    ).catch((err: unknown) => {
      log.error("Failed to end span:", err);
    });
  }

  addAttribute(spanId: string, key: string, value: unknown): void {
    getPool().query(
      `UPDATE trace_spans SET attributes = attributes || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ [key]: value }), spanId],
    ).catch((err: unknown) => {
      log.error("Failed to add span attribute:", err);
    });
  }
}
