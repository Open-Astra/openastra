/**
 * Mock data for development when the backend is not available.
 * All hooks fall back to this data when API calls fail.
 */
import type {
  Agent,
  Swarm,
  Session,
  Message,
  ScheduledTask,
  DashboardStats,
  InferenceProvider,
  Channel,
  LiveEvent,
  MemoryEntry,
  SkillGraph,
  SkillGraphValidation,
  ApprovalRequest,
  PromptVersion,
  AnomalyAlert,
} from "@/types/api";

function randomSparkline(length = 20, min = 10, max = 100): number[] {
  const data: number[] = [];
  let current = min + Math.random() * (max - min);
  for (let i = 0; i < length; i++) {
    current += (Math.random() - 0.48) * 10;
    current = Math.max(min, Math.min(max, current));
    data.push(Math.round(current));
  }
  return data;
}

export const mockAgents: Agent[] = [
  {
    id: "orchestrator",
    displayName: "Orchestrator",
    tier: "internal",
    model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    tools: { maxCalls: 50 },
    skills: ["routing", "planning", "delegation"],
    status: "busy",
    lastActiveAt: new Date().toISOString(),
    sessionCount: 42,
    totalInferences: 1284,
    memoryNamespace: "orchestrator",
    spawn: { enabled: true, maxDepth: 3 },
  },
  {
    id: "researcher",
    displayName: "Research Agent",
    tier: "premium",
    model: { provider: "openai", modelId: "gpt-4o" },
    tools: { allow: ["web_search", "read_url", "summarize"], maxCalls: 30 },
    skills: ["research", "summarization", "fact-checking"],
    status: "idle",
    lastActiveAt: new Date(Date.now() - 600_000).toISOString(),
    sessionCount: 18,
    totalInferences: 532,
    memoryNamespace: "researcher",
  },
  {
    id: "coder",
    displayName: "Code Assistant",
    tier: "premium",
    model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    tools: { allow: ["execute_code", "read_file", "write_file", "search_codebase"], maxCalls: 40 },
    skills: ["coding", "debugging", "code-review"],
    status: "idle",
    lastActiveAt: new Date(Date.now() - 1_800_000).toISOString(),
    sessionCount: 67,
    totalInferences: 2103,
    memoryNamespace: "coder",
  },
  {
    id: "writer",
    displayName: "Content Writer",
    tier: "free",
    model: { provider: "groq", modelId: "llama-3.3-70b-versatile" },
    tools: { allow: ["web_search", "draft", "edit_text"], maxCalls: 20 },
    skills: ["writing", "editing", "translation"],
    status: "offline",
    sessionCount: 5,
    totalInferences: 89,
  },
  {
    id: "data-analyst",
    displayName: "Data Analyst",
    tier: "premium",
    model: { provider: "google", modelId: "gemini-2.5-flash" },
    tools: { allow: ["execute_code", "chart", "sql_query"], maxCalls: 25 },
    skills: ["data-analysis", "visualization", "statistics"],
    status: "busy",
    lastActiveAt: new Date().toISOString(),
    sessionCount: 12,
    totalInferences: 340,
    memoryNamespace: "analyst",
  },
];

export const mockSwarms: Swarm[] = [
  {
    id: "research-team",
    name: "Research Team",
    agents: ["orchestrator", "researcher", "writer"],
    topology: "hierarchical",
    status: "idle",
    createdAt: new Date(Date.now() - 86_400_000 * 7).toISOString(),
    lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: "dev-squad",
    name: "Development Squad",
    agents: ["orchestrator", "coder", "data-analyst"],
    topology: "mesh",
    status: "busy",
    createdAt: new Date(Date.now() - 86_400_000 * 3).toISOString(),
    lastActiveAt: new Date().toISOString(),
  },
];

export const mockSessions: Session[] = Array.from({ length: 20 }, (_, i) => ({
  id: `session-${String(i + 1).padStart(3, "0")}`,
  agentId: mockAgents[i % mockAgents.length]!.id,
  agentName: mockAgents[i % mockAgents.length]!.displayName,
  surface: "chat" as const,
  createdAt: new Date(Date.now() - (i * 3_600_000 + Math.random() * 3_600_000)).toISOString(),
  lastActiveAt: new Date(Date.now() - i * 1_800_000).toISOString(),
  messageCount: Math.floor(Math.random() * 50) + 5,
  tokenCount: Math.floor(Math.random() * 50_000) + 1_000,
  status: i < 3 ? "active" as const : i === 5 ? "error" as const : "completed" as const,
  inferenceCount: Math.floor(Math.random() * 20) + 1,
  duration: Math.floor(Math.random() * 600_000) + 30_000,
}));

// Mock messages keyed by session ID — returns sample conversation for any session
export function getMockMessages(sessionId: string): Message[] {
  const base = Date.now() - 300_000;
  return [
    { id: `${sessionId}-m1`, role: "user", content: "Can you help me analyze the latest performance metrics and identify any bottlenecks?", timestamp: new Date(base).toISOString() },
    { id: `${sessionId}-m2`, role: "assistant", content: `I'll analyze the performance metrics for you. Let me pull up the latest data and run some diagnostics.\n\nHere's what I found:\n\n**CPU Usage**: Averaging 34% with spikes to 78% during inference batches\n**Memory**: 37.5% utilization — healthy headroom\n**Disk I/O**: Normal throughput, no queuing detected\n\nThe main bottleneck appears to be inference latency during peak hours (2-4pm UTC), where P95 response times increase from 320ms to ~890ms.`, timestamp: new Date(base + 15_000).toISOString(), toolCalls: [{ id: "tc-1", name: "system_metrics", arguments: '{"range":"24h"}', result: '{"cpu_avg":34,"memory_pct":37.5}' }] },
    { id: `${sessionId}-m3`, role: "user", content: "What's causing the latency spike? Is it the model provider or our infrastructure?", timestamp: new Date(base + 45_000).toISOString() },
    { id: `${sessionId}-m4`, role: "assistant", content: `Good question. I checked both sides:\n\n1. **Provider latency** (Anthropic): Their API response times remain stable at ~320ms during our peak window. So it's not upstream.\n\n2. **Our queue depth**: During 2-4pm we see 12-15 concurrent inference requests vs. our normal 3-5. The requests are queuing in our inference gateway.\n\n**Root cause**: We're hitting our concurrency limit of 10 on the inference pool. Requests 11+ wait in queue.\n\n**Recommendation**: Increase the inference pool concurrency to 20, or implement request prioritization so interactive chat gets priority over batch/scheduled tasks.`, timestamp: new Date(base + 90_000).toISOString(), toolCalls: [{ id: "tc-2", name: "query_logs", arguments: '{"service":"inference-gateway","window":"2h"}' }, { id: "tc-3", name: "provider_status", arguments: '{"provider":"anthropic"}', result: '{"latency_p95":320,"status":"healthy"}' }] },
    { id: `${sessionId}-m5`, role: "user", content: "Let's go with request prioritization. Can you draft the configuration changes?", timestamp: new Date(base + 120_000).toISOString() },
    { id: `${sessionId}-m6`, role: "assistant", content: `Here's the configuration change for the inference gateway:\n\n\`\`\`yaml\ninference:\n  pool:\n    concurrency: 10\n    prioritization:\n      enabled: true\n      queues:\n        - name: interactive\n          surfaces: [chat, prop]\n          priority: 1\n          reserved_slots: 4\n        - name: scheduled\n          surfaces: [scheduled, heartbeat]\n          priority: 2\n        - name: batch\n          surfaces: [group]\n          priority: 3\n\`\`\`\n\nThis reserves 4 slots for interactive chat, ensuring responsive UX even during peak batch processing. Scheduled and batch tasks will use remaining capacity. Want me to apply this?`, timestamp: new Date(base + 180_000).toISOString() },
    { id: `${sessionId}-m7`, role: "user", content: "Looks good, apply it.", timestamp: new Date(base + 200_000).toISOString() },
    { id: `${sessionId}-m8`, role: "assistant", content: "Done. The prioritization config has been applied and the inference gateway has been reloaded. I'll monitor the next peak window and report back on the latency improvements.\n\nExpected result: P95 interactive latency should drop back to ~350ms even during peak hours.", timestamp: new Date(base + 210_000).toISOString(), toolCalls: [{ id: "tc-4", name: "apply_config", arguments: '{"path":"inference.pool.prioritization","dry_run":false}', result: '{"applied":true,"reloaded":true}' }] },
  ];
}

export const mockProviders: InferenceProvider[] = [
  { id: "anthropic", name: "Anthropic", connected: true, latency: 320, models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"], requestsToday: 284, tokensToday: 1_420_000, costToday: 4.26, status: "healthy" },
  { id: "openai", name: "OpenAI", connected: true, latency: 450, models: ["gpt-4o", "gpt-4o-mini"], requestsToday: 156, tokensToday: 890_000, costToday: 2.67, status: "healthy" },
  { id: "google", name: "Google AI", connected: true, latency: 280, models: ["gemini-2.5-flash", "gemini-2.5-pro"], requestsToday: 92, tokensToday: 520_000, costToday: 0.52, status: "healthy" },
  { id: "groq", name: "Groq", connected: true, latency: 85, models: ["llama-3.3-70b-versatile"], requestsToday: 67, tokensToday: 340_000, costToday: 0.07, status: "healthy" },
  { id: "ollama", name: "Ollama (Local)", connected: false, models: ["llama3.3", "qwen2.5"], requestsToday: 0, tokensToday: 0, status: "down" },
];

export const mockChannels: Channel[] = [
  { id: "telegram", type: "telegram", name: "Telegram Bot", connected: true, lastActivity: new Date().toISOString() },
  { id: "discord", type: "discord", name: "Discord Bot", connected: true, lastActivity: new Date(Date.now() - 300_000).toISOString() },
  { id: "slack", type: "slack", name: "Slack Integration", connected: false },
  { id: "email", type: "email", name: "Email Channel", connected: true, lastActivity: new Date(Date.now() - 7_200_000).toISOString() },
  { id: "webhook", type: "webhook", name: "Webhooks", connected: true, lastActivity: new Date(Date.now() - 60_000).toISOString() },
];

export const mockDashboardStats: DashboardStats = {
  activeAgents: 2,
  activeSwarms: 1,
  runningSessions: 3,
  totalInferencesToday: 599,
  totalTokensToday: 3_170_000,
  totalCostToday: 7.52,
  systemHealth: {
    cpu: { usage: 34, cores: 8 },
    memory: { used: 6_442_450_944, total: 17_179_869_184, percentage: 37.5 },
    disk: { used: 107_374_182_400, total: 536_870_912_000, percentage: 20 },
    uptime: 432_000_000,
  },
  memoryUsage: {
    ephemeral: 128,
    daily: 1_420,
    longTerm: 8_932,
    graph: 4_210,
    procedural: 342,
  },
  topProviders: [
    { name: "Anthropic", requests: 284, tokens: 1_420_000 },
    { name: "OpenAI", requests: 156, tokens: 890_000 },
    { name: "Google AI", requests: 92, tokens: 520_000 },
    { name: "Groq", requests: 67, tokens: 340_000 },
  ],
  cpuHistory: randomSparkline(24, 15, 60),
  memoryHistory: randomSparkline(24, 30, 45),
  inferenceHistory: randomSparkline(24, 5, 40),
};

export const mockEvents: LiveEvent[] = [
  { id: "e1", type: "agent_start", agentName: "Orchestrator", content: "Started new session for user request", timestamp: new Date(Date.now() - 10_000).toISOString() },
  { id: "e2", type: "tool_call", agentName: "Research Agent", content: "Called web_search('latest AI benchmarks 2026')", timestamp: new Date(Date.now() - 30_000).toISOString() },
  { id: "e3", type: "handoff", agentName: "Orchestrator", content: "Delegated research task to Research Agent", timestamp: new Date(Date.now() - 45_000).toISOString() },
  { id: "e4", type: "memory_write", agentName: "Code Assistant", content: "Stored procedural memory: 'Python project setup workflow'", timestamp: new Date(Date.now() - 120_000).toISOString() },
  { id: "e5", type: "agent_complete", agentName: "Data Analyst", content: "Completed analysis of Q1 revenue data", timestamp: new Date(Date.now() - 300_000).toISOString() },
  { id: "e6", type: "tool_result", agentName: "Research Agent", content: "Retrieved 12 results from web search", timestamp: new Date(Date.now() - 25_000).toISOString() },
  { id: "e7", type: "error", agentName: "Content Writer", content: "Rate limit exceeded on Groq provider", timestamp: new Date(Date.now() - 600_000).toISOString() },
  { id: "e8", type: "spawn", agentName: "Orchestrator", content: "Spawned sub-agent 'Fact Checker' for verification task", timestamp: new Date(Date.now() - 180_000).toISOString() },
];

export const mockMemoryEntries: MemoryEntry[] = [
  { id: "m1", tier: "ephemeral", content: "User asked about latest AI benchmarks", timestamp: new Date().toISOString() },
  { id: "m2", tier: "ephemeral", content: "Current session context: research task on ML performance", timestamp: new Date().toISOString() },
  { id: "m3", tier: "daily", content: "User prefers concise responses with code examples", category: "preference", weight: 0.8, timestamp: new Date().toISOString() },
  { id: "m4", tier: "daily", content: "Discussed Python packaging tools: uv vs pip vs poetry", category: "topic", weight: 0.6, timestamp: new Date(Date.now() - 86_400_000).toISOString() },
  { id: "m5", tier: "long-term", content: "User is a senior software engineer at a startup", category: "profile", weight: 1.0, score: 0.95, timestamp: new Date(Date.now() - 86_400_000 * 30).toISOString() },
  { id: "m6", tier: "long-term", content: "Primary languages: TypeScript, Python, Rust", category: "skills", weight: 0.9, score: 0.92, timestamp: new Date(Date.now() - 86_400_000 * 14).toISOString() },
  { id: "m7", tier: "graph", content: "Entity: 'OpenAstra' -> 'agent runtime' (is_a), 'OpenAstra' -> 'Node.js' (built_with)", timestamp: new Date(Date.now() - 86_400_000 * 7).toISOString() },
  { id: "m8", tier: "procedural", content: "Workflow: When user asks for code review → read file → analyze → suggest improvements → apply if approved", category: "workflow", weight: 0.85, timestamp: new Date(Date.now() - 86_400_000 * 5).toISOString() },
];

export const mockSkillGraph: SkillGraph = {
  nodes: [
    { id: "researcher", name: "Research Agent", tools: ["web_search", "url_fetch"], composes: ["summary"], requires: ["search"], category: "analysis", version: "1.4.0" },
    { id: "coder", name: "Code Agent", tools: ["code_execute", "file_write"], composes: ["validation"], requires: ["analysis"], category: "engineering", version: "1.2.0" },
    { id: "writer", name: "Writer", tools: ["draft", "publish"], composes: [], requires: ["researcher"], category: "content", version: "1.1.0" },
    { id: "validator", name: "Validator", tools: ["claim_check"], composes: [], requires: ["researcher", "coder"], category: "quality", version: "1.0.0" },
  ],
  edges: [
    { from: "writer", to: "researcher", type: "requires" },
    { from: "coder", to: "validator", type: "composes" },
    { from: "validator", to: "researcher", type: "requires" },
    { from: "validator", to: "coder", type: "requires" },
  ],
};

export const mockSkillGraphValidation: SkillGraphValidation = {
  valid: true,
  errors: [],
  warnings: ["1 skill uses a fallback tool chain", "2 skills are in beta"],
  cycles: [],
};

export const mockApprovals: ApprovalRequest[] = [
  {
    id: "apr-1",
    workspaceId: "workspace-1",
    sessionId: "session-003",
    agentId: "coder",
    uid: "user-1",
    toolName: "shell_execute",
    toolArgs: { command: "npm test" },
    status: "pending",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  },
  {
    id: "apr-2",
    workspaceId: "workspace-1",
    sessionId: "session-007",
    agentId: "researcher",
    uid: "user-1",
    toolName: "web_search",
    toolArgs: { query: "latest OpenAI API docs" },
    status: "approved",
    expiresAt: new Date(Date.now() + 3_600_000 * 4).toISOString(),
    reviewedBy: "user-1",
    reviewedAt: new Date(Date.now() - 3_600_000).toISOString(),
    createdAt: new Date(Date.now() - 10_800_000).toISOString(),
  },
];

export const mockPromptVersions: Record<string, PromptVersion[]> = {
  orchestrator: [
    {
      id: "pv-1",
      agentId: "orchestrator",
      workspaceId: "workspace-1",
      version: 12,
      label: "Tighter delegation",
      systemPrompt: "Coordinate sub-agents, keep plans concise, and summarize progress clearly.",
      createdBy: "user-1",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
    {
      id: "pv-2",
      agentId: "orchestrator",
      workspaceId: "workspace-1",
      version: 11,
      label: "Preflight review",
      systemPrompt: "Review tools and task scope before delegating to workers.",
      createdBy: "user-1",
      createdAt: new Date(Date.now() - 86_400_000 * 4).toISOString(),
    },
  ],
  researcher: [
    {
      id: "pv-3",
      agentId: "researcher",
      workspaceId: "workspace-1",
      version: 4,
      label: "Source-first",
      systemPrompt: "Prefer primary sources and cite every factual claim.",
      createdBy: "user-1",
      createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
    },
  ],
};

export const mockAnomalyAlerts: AnomalyAlert[] = [
  {
    id: "alert-1",
    ruleId: "runaway_loop",
    ruleName: "Runaway Tool Loop",
    severity: "critical",
    toolName: "web_search",
    agentId: "researcher",
    uid: "user-1",
    description: "Tool \"web_search\" invoked 31 times in 60s by agent researcher",
    metadata: { callCount: 31, sessionId: "session-007" },
    timestamp: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    id: "alert-2",
    ruleId: "cost_spike",
    ruleName: "Session Cost Spike",
    severity: "high",
    toolName: "model_inference",
    agentId: "coder",
    uid: "user-1",
    description: "Session cost $1.2140 exceeded $1 threshold",
    metadata: { sessionCostUsd: 1.214, sessionId: "session-003" },
    timestamp: new Date(Date.now() - 1_200_000).toISOString(),
  },
  {
    id: "alert-3",
    ruleId: "path_traversal",
    ruleName: "Path Traversal Attempt",
    severity: "medium",
    toolName: "file_read",
    agentId: "validator",
    uid: "user-1",
    description: "Potential path traversal in \"file_read\" - contains ../",
    metadata: { hasTraversal: true, hasAbsPath: false, argsPreview: "../secrets/config.yml" },
    timestamp: new Date(Date.now() - 1_800_000).toISOString(),
  },
];

export const mockScheduledTasks: ScheduledTask[] = [
  {
    id: "st-001",
    uid: "user-1",
    workspaceId: null,
    agentId: "researcher",
    agentName: "Research Agent",
    cronExpression: "0 9 * * 1-5",
    runAt: null,
    prompt: "Check for new papers on arxiv.org related to multi-agent systems and summarize the top 3 most relevant ones.",
    enabled: true,
    lastRunAt: new Date(Date.now() - 3_600_000 * 5).toISOString(),
    nextRunAt: new Date(Date.now() + 3_600_000 * 19).toISOString(),
    runCount: 42,
    maxRuns: null,
    createdAt: new Date(Date.now() - 86_400_000 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000 * 5).toISOString(),
  },
  {
    id: "st-004",
    uid: "user-1",
    workspaceId: null,
    agentId: "data-analyst",
    agentName: "Data Analyst",
    cronExpression: "30 8 1 * *",
    runAt: null,
    prompt: "Generate the monthly usage report: token consumption, costs by provider, top agents by activity, and session statistics.",
    enabled: true,
    lastRunAt: new Date(Date.now() - 86_400_000 * 13).toISOString(),
    nextRunAt: new Date(Date.now() + 86_400_000 * 18).toISOString(),
    runCount: 3,
    maxRuns: null,
    createdAt: new Date(Date.now() - 86_400_000 * 90).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000 * 13).toISOString(),
  },
  {
    id: "st-005",
    uid: "user-1",
    workspaceId: null,
    agentId: "orchestrator",
    agentName: "Orchestrator",
    cronExpression: null,
    runAt: new Date(Date.now() + 86_400_000 * 2).toISOString(),
    prompt: "Run a full system health audit: check all inference providers, validate memory tier integrity, and report any anomalies.",
    enabled: true,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + 86_400_000 * 2).toISOString(),
    runCount: 0,
    maxRuns: 1,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: "st-006",
    uid: "user-1",
    workspaceId: null,
    agentId: "writer",
    agentName: "Content Writer",
    cronExpression: "0 10 * * 1",
    runAt: null,
    prompt: "Draft a weekly changelog summary from the past week's git commits and create a newsletter-ready blog post.",
    enabled: false,
    lastRunAt: new Date(Date.now() - 86_400_000 * 14).toISOString(),
    nextRunAt: null,
    runCount: 6,
    maxRuns: null,
    createdAt: new Date(Date.now() - 86_400_000 * 50).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000 * 14).toISOString(),
  },
];
