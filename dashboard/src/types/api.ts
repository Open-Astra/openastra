// OpenAstra API Types — derived from backend src/agents/types.ts, src/sessions/types.ts, src/memory/types.ts

export type AgentStatus = "idle" | "busy" | "error" | "offline";
export type SessionStatus = "active" | "completed" | "error" | "timeout";
export type MemoryTier = "ephemeral" | "daily" | "long-term" | "graph" | "procedural";
export type SessionSurface = "chat" | "prop" | "group" | "heartbeat";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type WorkspacePlan = "personal" | "team" | "enterprise";

export interface Agent {
  id: string;
  displayName: string;
  tier: "free" | "premium" | "internal";
  model: {
    provider: string;
    modelId: string;
    endpoint?: string;
  };
  systemPromptTemplate?: string;
  tools: {
    allow?: string[];
    deny?: string[];
    maxCalls?: number;
  };
  skills: string[];
  status: AgentStatus;
  lastActiveAt?: string;
  sessionCount: number;
  totalInferences: number;
  memoryNamespace?: string;
  handoffTargets?: string[];
  spawn?: {
    enabled: boolean;
    allowedTargets?: string[];
    maxDepth?: number;
  };
}

export interface Swarm {
  id: string;
  name: string;
  agents: string[];
  topology: "hierarchical" | "flat" | "mesh";
  status: AgentStatus;
  createdAt: string;
  lastActiveAt?: string;
}

export interface Session {
  id: string;
  agentId: string;
  agentName?: string;
  surface: SessionSurface;
  surfaceId?: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  tokenCount: number;
  status: SessionStatus;
  inferenceCount: number;
  duration?: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  tokenEstimate?: number;
  timestamp: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
}

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  category?: string;
  weight?: number;
  score?: number;
  source?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryProfile {
  displayName?: string;
  timezone?: string;
  locale?: string;
  strategicNotes: string[];
  interests: string[];
  domains: string[];
}

export interface ScheduledTask {
  id: string;
  uid: string;
  workspaceId: string | null;
  agentId: string;
  agentName?: string;
  cronExpression: string | null;
  runAt: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SystemMetrics {
  cpu: { usage: number; cores: number };
  memory: { used: number; total: number; percentage: number };
  disk: { used: number; total: number; percentage: number };
  uptime: number;
}

export interface InferenceProvider {
  id: string;
  name: string;
  connected: boolean;
  latency?: number;
  models: string[];
  requestsToday: number;
  tokensToday: number;
  costToday?: number;
  status: "healthy" | "degraded" | "down";
}

export interface Channel {
  id: string;
  type: string;
  name: string;
  connected: boolean;
  lastActivity?: string;
}

export interface SkillGraphNode {
  id: string;
  name: string;
  tools: string[];
  composes: string[];
  requires: string[];
  category: string;
  version: string;
}

export interface SkillGraphEdge {
  from: string;
  to: string;
  type: "composes" | "requires";
}

export interface SkillGraph {
  nodes: SkillGraphNode[];
  edges: SkillGraphEdge[];
}

export interface SkillGraphValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  cycles: string[][];
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  agentId: string;
  uid: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface PipelineStage {
  agentId: string;
  systemPromptSuffix?: string;
}

export interface PipelineStageResult {
  agentId: string;
  input: string;
  output: string;
  durationMs: number;
}

export interface PipelineRunResult {
  pipelineId: string;
  stages: PipelineStageResult[];
  finalOutput: string;
  totalDurationMs: number;
}

export interface PromptVersion {
  id: string;
  agentId: string;
  workspaceId: string;
  version: number;
  label: string | null;
  systemPrompt: string;
  createdBy: string | null;
  createdAt: string;
}

export interface AnomalyAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: "low" | "medium" | "high" | "critical";
  toolName: string;
  agentId?: string;
  uid?: string;
  description: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface LiveEvent {
  id: string;
  type: "agent_start" | "agent_complete" | "tool_call" | "tool_result" | "handoff" | "error" | "memory_write" | "spawn" | "message";
  agentId?: string;
  agentName?: string;
  sessionId?: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface DashboardStats {
  activeAgents: number;
  activeSwarms: number;
  runningSessions: number;
  totalInferencesToday: number;
  totalTokensToday: number;
  totalCostToday: number;
  systemHealth: SystemMetrics;
  memoryUsage: {
    ephemeral: number;
    daily: number;
    longTerm: number;
    graph: number;
    procedural: number;
  };
  topProviders: { name: string; requests: number; tokens: number }[];
  cpuHistory: number[];
  memoryHistory: number[];
  inferenceHistory: number[];
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  version: string;
  uptime: number;
  database: boolean;
  search: boolean;
}
