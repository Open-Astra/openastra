import { z } from "zod";

// ── Tool Definition ─────────────────────────────────────────────────
// Each tool declares its name, description, parameter schema (Zod),
// and an execute function. The registry converts Zod schemas to
// JSON Schema for the LLM's tool-use protocol.

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryOn?: string[]; // Only retry when error message matches one of these strings
}

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams, ctx: ToolContext) => Promise<TResult>;
  retryable?: boolean;
  retryPolicy?: RetryPolicy;               // Feature 17: per-tool retry policy
  async?: boolean;                         // NEW: returns {taskId} immediately
  outputSchema?: z.ZodType<TResult>;       // NEW: #12 — validate output shape
  executeBatch?: (params: TParams[], ctx: ToolContext) => Promise<TResult[]>; // NEW: #13
  batchable?: boolean;                     // NEW: #13
  dependsOn?: string[];                    // NEW: #14
  estimatedCostUsd?: number;               // NEW: #15 — cost per call
  requiresApproval?: boolean;              // Feature 15: requires human approval before execution
}

// ── Tool Context ────────────────────────────────────────────────────
// Passed to every tool at execution time. Gives tools access to the
// user's identity and memory without coupling them to Firestore.

export interface ToolContext {
  uid: string;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  traceId?: string;
  constraints?: {                          // Feature 6: constraint propagation
    budgetUsd?: number;
    deadlineMs?: number;
    maxTokens?: number;
  };
  metadata?: Record<string, unknown>;      // Feature 20: guard metadata (role, etc.)
}

// ── Tool Call (from LLM) ────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string from the model
}

// ── Tool Result ─────────────────────────────────────────────────────

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string; // serialized result sent back to the model
  durationMs: number;
  error?: string;
  costUsd?: number;  // NEW: #15
}

// ── Tool Policy ─────────────────────────────────────────────────────
// Cascading resolution: global defaults → agent overrides → spawn restrictions

export interface ToolPolicy {
  allow: Set<string>;
  deny: Set<string>;
}

export function resolveToolPolicy(
  globalAllow: string[],
  agentAllow: string[],
  agentDeny: string[],
): ToolPolicy {
  const allow = new Set([...globalAllow, ...agentAllow]);
  const deny = new Set(agentDeny);
  // Deny takes precedence
  for (const d of deny) {
    allow.delete(d);
  }
  return { allow, deny };
}
