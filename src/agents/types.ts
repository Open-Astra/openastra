import { z } from "zod";

// ── Agent Identity ──────────────────────────────────────────────────

export const AgentId = z.string();
export type AgentId = z.infer<typeof AgentId>;

export const AgentTier = z.enum(["free", "premium", "internal"]);
export type AgentTier = z.infer<typeof AgentTier>;

// ── Agent Configuration ─────────────────────────────────────────────
// Declarative agent config — stored in Postgres at agent_configs table,
// hydrated into runtime registry on startup and on dynamic creation.

export const AgentConfig = z.object({
  id: z.string(),
  displayName: z.string(),
  tier: AgentTier,

  // Inference target
  model: z.object({
    provider: z.enum(["grok", "groq", "openai", "gemini", "claude", "vllm", "ollama", "openrouter", "mistral", "bedrock", "edge"]),
    modelId: z.string(),
    endpoint: z.string().url().optional(),
    maxContextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).default(0.7),
    capabilities: z.array(z.enum(["vision", "tool_calling", "code", "reasoning"])).optional(),
    // Feature 10: Extended thinking
    budgetThinkingTokens: z.number().int().nonnegative().default(0).optional(),
    useExtendedThinking: z.boolean().default(false).optional(),
    thinkingBudget: z.enum(["min", "normal", "max"]).optional(),
  }),

  // System prompt template — supports {{variable}} interpolation
  systemPromptTemplate: z.string(),

  // Tool policy: which tools this agent can call
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()).default([]),
    maxToolCallsPerRound: z.number().int().positive().default(8),
  }),

  // Skills: which skills this agent has access to
  skills: z.array(z.string()).default([]),

  // Session behavior
  session: z.object({
    dailyResetHour: z.number().int().min(0).max(23).default(4),
    idleTimeoutMinutes: z.number().int().positive().default(120),
    maxContextMessages: z.number().int().positive().default(50),
  }),

  // Spawn policy — can this agent delegate to sub-agents?
  spawn: z
    .object({
      enabled: z.boolean().default(false),
      allowedTargets: z.array(z.string()).default([]),
      maxDepth: z.number().int().min(1).max(3).default(2),
    })
    .default({ enabled: false, allowedTargets: [], maxDepth: 2 }),

  // File access restrictions — limits which paths the agent can read/write.
  // By default agents can only access the configured allowed paths.
  // This must be explicitly set during onboarding or agent creation.
  fileAccess: z
    .object({
      restricted: z.boolean().default(true),
      allowedPaths: z.array(z.string()).default([]),
    })
    .default({ restricted: true, allowedPaths: [] }),

  // Feature 3: Confidence thresholds
  confidenceThreshold: z.number().min(0).max(1).optional(),
  confidenceEscalationAgent: z.string().optional(),

  // Feature 4: Adaptive personas
  personas: z.record(z.string(), z.object({
    systemPromptOverride: z.string(),
    tools: z.object({
      allow: z.array(z.string()),
      deny: z.array(z.string()),
    }),
  })).optional(),

  // Feature 21: Memory namespace (used by Wave 4)
  memoryNamespace: z.string().optional(),

  // Feature 17: Handoff targets (used by Wave 3)
  handoffTargets: z.array(z.string()).optional(),

  // Feature 35: Permission requests (used by Wave 6)
  permissionRequestsEnabled: z.boolean().optional(),

  // Wave 1: A/B testing — expected tone for drift detection
  expectedTone: z.enum(["formal", "casual", "technical", "neutral"]).optional(),

  // Wave 1: Planner mode — decompose goal into sequential steps before responding
  plannerMode: z.boolean().optional(),

  // Feature batch 2: Inference policy
  // Ordered list of "provider:model" strings to try if primary fails.
  fallbackChain: z.array(z.string()).optional(),
  // Race primary provider against first fallback; use whichever answers first.
  raceMode: z.boolean().optional(),

  // Feature batch 2: Session token budget (0 = unlimited).
  sessionTokenBudget: z.number().int().nonnegative().optional(),

  // Feature batch 2: Skill chain IDs to include for this agent.
  skillChains: z.array(z.string()).optional(),

  // Schedule: optional cron-based autonomous execution
  schedule: z.object({
    cron: z.string(),
    taskMessage: z.string(),
    uid: z.string().optional(),
  }).optional(),

  // Feature 8: Multi-turn memory refinement
  refinement: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(["daily", "weekly", "manual"]).default("manual"),
    autoSupersede: z.boolean().default(false),
  }).optional(),

  // Feature 11: Agent self-critique loop
  selfCritique: z.object({
    enabled: z.boolean().default(false),
    passes: z.number().int().min(1).max(3).default(1),
    triggers: z.array(z.enum(["tool_error", "low_confidence", "long_response", "always"])).optional(),
  }).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfig>;

// ── Runtime Agent State ─────────────────────────────────────────────

export interface AgentTurn {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCallRecord[];
  tokenEstimate: number;
  timestamp: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}
