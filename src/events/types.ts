import { z } from "zod";

// ── Event Bus Type Definitions ──────────────────────────────────────
// Typed event definitions for the system-wide event bus.
// Every feature emits/consumes events through this interface.

// ── Event Schemas ───────────────────────────────────────────────────

export const MemoryWrittenEvent = z.object({
  uid: z.string(),
  category: z.string(),
  content: z.string(),
  timestamp: z.number(),
});

export const ToolExecutedEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
  traceId: z.string().optional(),
  timestamp: z.number(),
});

export const AgentStartedEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  traceId: z.string().optional(),
  timestamp: z.number(),
});

export const AgentCompletedEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  content: z.string(),
  workspaceId: z.string().optional(),
  tokenUsage: z.object({
    prompt: z.number(),
    completion: z.number(),
    total: z.number(),
  }),
  toolResults: z.array(z.object({
    name: z.string(),
    durationMs: z.number(),
    error: z.string().optional(),
  })),
  traceId: z.string().optional(),
  timestamp: z.number(),
});

export const AgentStreamDeltaEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  delta: z.string(),
  traceId: z.string().optional(),
  timestamp: z.number(),
});

export const AgentSpawnStartedEvent = z.object({
  taskId: z.string(),
  parentAgentId: z.string(),
  targetAgentId: z.string(),
  uid: z.string(),
  task: z.string(),
  depth: z.number(),
  timestamp: z.number(),
});

export const AgentSpawnCompletedEvent = z.object({
  taskId: z.string(),
  parentAgentId: z.string(),
  targetAgentId: z.string(),
  uid: z.string(),
  content: z.string(),
  success: z.boolean(),
  durationMs: z.number(),
  timestamp: z.number(),
});

export const SessionCreatedEvent = z.object({
  uid: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  timestamp: z.number(),
});

export const SessionArchivedEvent = z.object({
  uid: z.string(),
  sessionId: z.string(),
  reason: z.string(),
  timestamp: z.number(),
});

export const SessionDeadlockExpiredEvent = z.object({
  sessionId: z.string(),
  timestamp: z.number(),
});

export const WsConnectedEvent = z.object({
  uid: z.string(),
  deviceCount: z.number(),
  timestamp: z.number(),
});

export const WsDisconnectedEvent = z.object({
  uid: z.string(),
  deviceCount: z.number(),
  timestamp: z.number(),
});

export const PluginLoadedEvent = z.object({
  name: z.string(),
  version: z.string(),
  timestamp: z.number(),
});

export const PluginErrorEvent = z.object({
  name: z.string(),
  error: z.string(),
  timestamp: z.number(),
});

export const PresenceUpdatedEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  status: z.string(),
  currentTool: z.string().optional(),
  timestamp: z.number(),
});

export const WebhookDispatchedEvent = z.object({
  uid: z.string(),
  webhookId: z.string(),
  eventType: z.string(),
  statusCode: z.number().optional(),
  success: z.boolean(),
  timestamp: z.number(),
});

export const AgentMessageEvent = z.object({
  messageId: z.string(),
  fromAgentId: z.string(),
  toAgentId: z.string(),
  uid: z.string(),
  content: z.string(),
  timestamp: z.number(),
});

// ── Team Feature Events ─────────────────────────────────────────────

export const WorkspaceMemoryWrittenEvent = z.object({
  workspaceId: z.string(),
  authorId: z.string(),
  category: z.string(),
  entryId: z.string(),
  timestamp: z.number(),
});

export const DiagnosticCompletedEvent = z.object({
  runId: z.string(),
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  checkCount: z.number(),
  durationMs: z.number(),
  timestamp: z.number(),
});

export const CodebaseIndexedEvent = z.object({
  workspaceId: z.string(),
  indexed: z.number(),
  skipped: z.number(),
  total: z.number(),
  timestamp: z.number(),
});

export const CostThresholdEvent = z.object({
  workspaceId: z.string().optional(),
  currentCost: z.number(),
  threshold: z.number(),
  period: z.string(),
  timestamp: z.number(),
});

export const HeartbeatCompletedEvent = z.object({
  configId: z.string(),
  configName: z.string(),
  uid: z.string(),
  status: z.enum(["ok", "changed", "error", "timeout"]),
  agentSummary: z.string(),
  timestamp: z.number(),
});

export const SkillExecutedEvent = z.object({
  uid: z.string(),
  skillId: z.string(),
  toolName: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
  timestamp: z.number(),
});

export const AgentMetricsEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  traceId: z.string().optional(),
  contextAssemblyMs: z.number(),
  inferenceMs: z.number(),
  toolExecutionMs: z.number(),
  totalTokens: z.number(),
  round: z.number(),
  timestamp: z.number(),
});

// ── Inference Events ────────────────────────────────────────────────

export const InferenceRequestEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  provider: z.string(),
  modelId: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  durationMs: z.number(),
  cached: z.boolean().optional(),
  traceId: z.string().optional(),
  timestamp: z.number(),
});

// ── Job Events ──────────────────────────────────────────────────────

export const JobStartedEvent = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  workerId: z.string(),
  timestamp: z.number(),
});

export const JobCompletedEvent = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  durationMs: z.number(),
  timestamp: z.number(),
});

export const JobFailedEvent = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  type: z.string(),
  error: z.string(),
  retryCount: z.number(),
  willRetry: z.boolean(),
  timestamp: z.number(),
});

// ── Security Events ──────────────────────────────────────────────────

export const SecurityTokenReplayEvent = z.object({
  uid: z.string(),
  jti: z.string().optional(),
  tokenFamily: z.string().optional(),
  ip: z.string().optional(),
  severity: z.literal("critical"),
  timestamp: z.number(),
});

export const SecurityTokenRevokedEvent = z.object({
  uid: z.string(),
  jti: z.string(),
  revokedBy: z.string(),
  timestamp: z.number(),
});

export const SecurityIntrusionDetectedEvent = z.object({
  category: z.string(),
  sourceIp: z.string(),
  uid: z.string().optional(),
  count: z.number(),
  windowMs: z.number(),
  detail: z.string(),
  severity: z.string(),
});

// ── Caching & Heartbeat Events ──────────────────────────────────────

export const CachePressureEvent = z.object({
  cacheType: z.string(),
  fillPercent: z.number(),
  size: z.number(),
  maxSize: z.number(),
  timestamp: z.number(),
});

export const ProviderHealthDegradedEvent = z.object({
  provider: z.string(),
  errorRate: z.number(),
  timestamp: z.number(),
});

export const ProviderHealthRecoveredEvent = z.object({
  provider: z.string(),
  timestamp: z.number(),
});

export const InferenceLatencyDegradedEvent = z.object({
  provider: z.string(),
  modelId: z.string(),
  trendSlope: z.number(),
  currentP95Ms: z.number(),
  timestamp: z.number(),
});

// ── Feature 8: Memory Refinement Events ─────────────────────────────

export const MemoryRefinedEvent = z.object({
  uid: z.string(),
  sessionId: z.string(),
  consolidated: z.number(),
  conflicts: z.array(z.object({
    entry1: z.string(),
    entry2: z.string(),
    similarity: z.number(),
  })),
  superseded: z.array(z.string()),
  timestamp: z.number(),
});

// ── Feature 10: Extended Thinking Events ────────────────────────────

export const AgentExtendedThinkingEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  thinkingTokens: z.number(),
  durationMs: z.number(),
  timestamp: z.number(),
});

// ── Feature 11: Self-Critique Events ────────────────────────────────

export const AgentSelfCritiqueEvent = z.object({
  uid: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  passes: z.number(),
  originalLength: z.number(),
  revisedLength: z.number(),
  timestamp: z.number(),
});

// ── Feature 12: Skill Evolution Events ──────────────────────────────

export const SkillEvolvedEvent = z.object({
  skillId: z.string(),
  agentId: z.string(),
  oldSuccessRate: z.number(),
  newSuccessRate: z.number(),
  improvements: z.array(z.string()),
  timestamp: z.number(),
});

// ── Feature 13: Tool Composition Events ─────────────────────────────

export const ToolComposedEvent = z.object({
  chainedTools: z.array(z.string()),
  duration: z.number(),
  finalOutput: z.string(),
  errors: z.array(z.string()).optional(),
  timestamp: z.number(),
});

// ── Feature 14: Skill Conditional Blocking Events ────────────────────

export const SkillConditionalBlockedEvent = z.object({
  skillId: z.string(),
  agentId: z.string(),
  reason: z.string(),
  timestamp: z.number(),
});

// ── Event Map ───────────────────────────────────────────────────────
// Maps event names to their Zod schemas and inferred types.

export const EventSchemas = {
  "memory.written": MemoryWrittenEvent,
  "tool.executed": ToolExecutedEvent,
  "agent.started": AgentStartedEvent,
  "agent.completed": AgentCompletedEvent,
  "agent.stream.delta": AgentStreamDeltaEvent,
  "agent.spawn.started": AgentSpawnStartedEvent,
  "agent.spawn.completed": AgentSpawnCompletedEvent,
  "agent.message": AgentMessageEvent,
  "session.created": SessionCreatedEvent,
  "session.archived": SessionArchivedEvent,
  "session.deadlock_expired": SessionDeadlockExpiredEvent,
  "ws.connected": WsConnectedEvent,
  "ws.disconnected": WsDisconnectedEvent,
  "plugin.loaded": PluginLoadedEvent,
  "plugin.error": PluginErrorEvent,
  "presence.updated": PresenceUpdatedEvent,
  "webhook.dispatched": WebhookDispatchedEvent,
  "workspace.memory.written": WorkspaceMemoryWrittenEvent,
  "diagnostic.completed": DiagnosticCompletedEvent,
  "codebase.indexed": CodebaseIndexedEvent,
  "cost.threshold": CostThresholdEvent,
  "heartbeat.completed": HeartbeatCompletedEvent,
  "skill.executed": SkillExecutedEvent,
  "agent.metrics": AgentMetricsEvent,
  "inference.request": InferenceRequestEvent,
  "job.started": JobStartedEvent,
  "job.completed": JobCompletedEvent,
  "job.failed": JobFailedEvent,
  "security.token_replay": SecurityTokenReplayEvent,
  "security.token_revoked": SecurityTokenRevokedEvent,
  "security.intrusion_detected": SecurityIntrusionDetectedEvent,
  "cache.pressure": CachePressureEvent,
  "provider.health.degraded": ProviderHealthDegradedEvent,
  "provider.health.recovered": ProviderHealthRecoveredEvent,
  "inference.latency.degraded": InferenceLatencyDegradedEvent,
  "memory.refined": MemoryRefinedEvent,
  "agent.extended_thinking": AgentExtendedThinkingEvent,
  "agent.self_critique": AgentSelfCritiqueEvent,
  "skill.evolved": SkillEvolvedEvent,
  "tool.composed": ToolComposedEvent,
  "skill.conditional_blocked": SkillConditionalBlockedEvent,
} as const;

export type EventName = keyof typeof EventSchemas;

// Infer the payload type for any event name
export type EventPayload<K extends EventName> = z.infer<(typeof EventSchemas)[K]>;

// All possible payloads (union)
export type AnyEventPayload = EventPayload<EventName>;

// Handler type for a specific event
export type EventHandler<K extends EventName> = (payload: EventPayload<K>) => void | Promise<void>;

// Wildcard handler receives event name + payload
export type WildcardHandler = (eventName: EventName, payload: AnyEventPayload) => void | Promise<void>;
