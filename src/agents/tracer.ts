import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Agent Tracer ────────────────────────────────────────────────────
// Accumulates per-turn trace data in memory, writes a single INSERT
// on finish(). Non-throwing — all DB errors are fire-and-forget.

const log = createLogger("tracer");

interface ToolCallEntry {
  toolName: string;
  durationMs: number;
  error?: string;
  timestamp: number;
}

interface CircuitBreakerEntry {
  provider: string;
  event: "opened" | "closed" | "half-open" | "fast-fail";
  timestamp: number;
}

export class AgentTracer {
  private readonly traceId: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly uid: string;
  private readonly workspaceId: string | undefined;
  private startedAt = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private toolCalls: ToolCallEntry[] = [];
  private circuitBreakerEvents: CircuitBreakerEntry[] = [];

  constructor(params: {
    traceId: string;
    sessionId: string;
    agentId: string;
    uid: string;
    workspaceId?: string;
  }) {
    this.traceId = params.traceId;
    this.sessionId = params.sessionId;
    this.agentId = params.agentId;
    this.uid = params.uid;
    this.workspaceId = params.workspaceId;
  }

  start(): void {
    this.startedAt = Date.now();
  }

  addToolCall(toolName: string, durationMs: number, error?: string): void {
    this.toolCalls.push({ toolName, durationMs, error, timestamp: Date.now() });
  }

  addCircuitBreakerEvent(provider: string, event: CircuitBreakerEntry["event"]): void {
    this.circuitBreakerEvents.push({ provider, event, timestamp: Date.now() });
  }

  setTokens(prompt: number, completion: number, total: number): void {
    this.promptTokens = prompt;
    this.completionTokens = completion;
    this.totalTokens = total;
  }

  finish(status: "completed" | "timeout" | "error", errorMessage?: string): void {
    if (this.startedAt === 0) return;
    const finishedAt = Date.now();
    const durationMs = finishedAt - this.startedAt;

    getPool().query(
      `INSERT INTO agent_traces
         (id, session_id, agent_id, workspace_id, uid,
          started_at, finished_at, duration_ms,
          prompt_tokens, completion_tokens, total_tokens,
          tool_calls, circuit_breaker_events,
          final_status, error_message)
       VALUES ($1, $2, $3, $4, $5,
               to_timestamp($6::double precision / 1000),
               to_timestamp($7::double precision / 1000), $8,
               $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)`,
      [
        this.traceId,
        this.sessionId,
        this.agentId,
        this.workspaceId ?? null,
        this.uid,
        this.startedAt,
        finishedAt,
        durationMs,
        this.promptTokens,
        this.completionTokens,
        this.totalTokens,
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.circuitBreakerEvents),
        status,
        errorMessage ?? null,
      ],
    ).catch((err: unknown) => {
      log.error("Failed to persist trace:", err);
    });
  }
}
