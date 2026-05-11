// ── Streaming Tool Results ────────────────────────────────────────────
// Allows tools to emit incremental progress events during long operations.

import type { ToolContext } from "./types.js";

export interface ToolProgressEvent {
  toolName: string;
  step: string;
  progress: number; // 0–100
  data?: unknown;
}

export interface StreamingToolContext extends ToolContext {
  emit(event: ToolProgressEvent): void;
  isStreaming: true;
}

export function createStreamingContext(
  baseCtx: ToolContext,
  emitter: (event: ToolProgressEvent) => void,
): StreamingToolContext {
  return {
    ...baseCtx,
    isStreaming: true as const,
    emit: emitter,
  };
}

export function isStreamingContext(ctx: unknown): ctx is StreamingToolContext {
  return typeof ctx === "object" && ctx !== null && (ctx as StreamingToolContext).isStreaming === true;
}
