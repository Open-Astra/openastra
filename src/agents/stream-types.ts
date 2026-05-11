// ── Agent Stream Event Types ────────────────────────────────────────
// Discriminated union for events yielded by the streaming agent loop.
// Each event represents a distinct stage of the agent execution.

export type AgentStreamEvent =
  | SessionResolvedEvent
  | InferenceStartEvent
  | StreamDeltaEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallCompleteEvent
  | ToolResultEvent
  | ToolProgressEvent
  | InferenceDoneEvent
  | RetryWebSearchEvent
  | BranchCreatedEvent
  | BranchSwitchedEvent
  | CompletedEvent
  | ErrorEvent;

export interface SessionResolvedEvent {
  type: "session_resolved";
  sessionId: string;
  isNew: boolean;
}

export interface InferenceStartEvent {
  type: "inference_start";
  round: number;
}

export interface StreamDeltaEvent {
  type: "stream_delta";
  content: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  index: number;
  id: string;
  name: string;
}

export interface ToolCallArgsEvent {
  type: "tool_call_args";
  index: number;
  args: string; // partial JSON chunk
}

export interface ToolCallCompleteEvent {
  type: "tool_call_complete";
  index: number;
  id: string;
  name: string;
  arguments: string; // full JSON string
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  name: string;
  content: string;
  durationMs: number;
  error?: string;
}

export interface InferenceDoneEvent {
  type: "inference_done";
  round: number;
  finishReason: string;
  usage: {
    prompt: number;
    completion: number;
    total: number;
    cached: number;
  };
}

export interface ToolProgressEvent {
  type: "tool_progress";
  toolCallId: string;
  name: string;
  progress: number;
  message?: string;
}

export interface BranchCreatedEvent {
  type: "branch_created";
  branchId: string;
  branchSessionId: string;
  parentSessionId: string;
  fromMessageIndex: number;
  label?: string;
}

export interface BranchSwitchedEvent {
  type: "branch_switched";
  branchId: string;
  branchSessionId: string;
  parentSessionId: string;
}

export interface CompletedEvent {
  type: "completed";
  content: string;
  sessionId: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
    cached: number;
  };
  toolResults: Array<{
    name: string;
    durationMs: number;
    error?: string;
  }>;
  enrichments?: {
    mood?: string;
    confidence?: number;
    toneDrift?: {
      drifted: boolean;
      expectedTone: string;
      actualTone: string;
      severity: string;
    } | null;
    goals?: string[];
    persona?: string | null;
  };
}

export interface RetryWebSearchEvent {
  type: "retry_web_search";
}

export interface ErrorEvent {
  type: "error";
  message: string;
}
