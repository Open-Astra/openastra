import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from "./types.js";
import type { ToolSchema } from "../inference/types.js";
import { zodToJsonSchema } from "./schema.js";
import { getCachedResult, setCachedResult, shouldCache } from "./cache.js";
import { createLogger } from "../utils/logger.js";
import { requestApproval } from "../agents/approval-gate.js";
import { getToolRiskLevel, canRoleExecuteTool } from "./risk-levels.js";
import { getWorkspaceRole } from "../gateway/middleware/rbac.js";

const logger = createLogger("tool-registry");

// ── Zod Error Formatter ─────────────────────────────────────────────
// Converts Zod validation errors into clear, actionable messages that
// help the LLM self-correct on the next tool call round.

function formatZodError(err: z.ZodError, toolName: string): string {
  const issues = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    // Detect missing required params (input is undefined)
    if (issue.input === undefined) {
      return `Missing required parameter: "${path}"`;
    }
    return `Parameter "${path}": ${issue.message}`;
  });

  // Build a hint showing required params from the registered tool's schema
  const tool = tools.get(toolName);
  let hint = "";
  if (tool) {
    try {
      const schema = zodToJsonSchema(tool.parameters);
      const props = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
      const required = (schema["required"] as string[]) ?? [];
      if (props && required.length > 0) {
        const example: Record<string, string> = {};
        for (const name of required) {
          const prop = props[name];
          example[name] = prop?.["description"] as string ?? `<${prop?.["type"] ?? "value"}>`;
        }
        hint = `\nExpected format: ${toolName}(${JSON.stringify(example)})`;
      }
    } catch { /* best-effort hint */ }
  }

  return `Tool "${toolName}" validation failed:\n${issues.join("\n")}${hint}`;
}

// ── Tool Registry ───────────────────────────────────────────────────
// Central registry that holds all tool definitions. The agent loop
// queries this to get JSON schemas for the LLM and to execute calls.

const tools = new Map<string, ToolDefinition>();

export function registerTool<TParams, TResult>(
  tool: ToolDefinition<TParams, TResult>,
): void {
  if (tools.has(tool.name)) {
    if (!process.env.ASTRA_STANDALONE) {
      logger.warn(`Tool already registered: ${tool.name} — skipping duplicate`);
    }
    return;
  }
  tools.set(tool.name, tool as ToolDefinition);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function unregisterTool(name: string): void {
  tools.delete(name);
}

export function getRegisteredToolCount(): number {
  return tools.size;
}

export function getRegisteredToolNames(): string[] {
  return [...tools.keys()];
}

// ── Get Schemas for LLM ─────────────────────────────────────────────
// Filters to only the tools allowed by the agent's policy, then
// converts Zod schemas to JSON Schema for the OpenAI tools format.

export function getToolSchemas(allowedTools: Set<string>): ToolSchema[] {
  const schemas: ToolSchema[] = [];

  for (const [name, tool] of tools) {
    if (!allowedTools.has(name)) continue;

    schemas.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.parameters),
      },
    });
  }

  return schemas;
}

// ── High-Risk Tool Audit ─────────────────────────────────────────────
// These tools are security-sensitive and get extra validation + audit logging.

const HIGH_RISK_TOOLS = new Set([
  "code_execute",
  "sql-query",
  "spawn",
  "http_request",
  "url_fetch",
  "patch-apply",
  "file_write",
]);

// ── Tool Rate Limiting ──────────────────────────────────────────────
// Per-user sliding window rate limits for dangerous tools.

const TOOL_RATE_LIMITS: Record<string, number> = {
  code_execute: 5,    // 5 calls/minute
  "sql-query": 20,    // 20 calls/minute
  http_request: 30,   // 30 calls/minute
  url_fetch: 30,      // 30 calls/minute
};
const DEFAULT_RATE_LIMIT = 60; // 60 calls/minute for other tools

const toolCallTimestamps = new Map<string, number[]>();

function checkToolRateLimit(toolName: string, uid: string): string | null {
  const limit = TOOL_RATE_LIMITS[toolName] ?? DEFAULT_RATE_LIMIT;
  const key = `${uid}:${toolName}`;
  const now = Date.now();
  const windowMs = 60_000;

  let timestamps = toolCallTimestamps.get(key);
  if (!timestamps) {
    timestamps = [];
    toolCallTimestamps.set(key, timestamps);
  }

  // Prune old timestamps
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0]! < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    const oldestInWindow = timestamps[0]!;
    const retryAfterMs = oldestInWindow + windowMs - now;
    return `Rate limit exceeded for tool "${toolName}". Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`;
  }

  timestamps.push(now);
  return null;
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of toolCallTimestamps) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) toolCallTimestamps.delete(key);
    else toolCallTimestamps.set(key, fresh);
  }
}, 5 * 60_000).unref();

// ── Execute Tool Call ───────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  allowedTools: Set<string>,
): Promise<ToolResult> {
  const start = Date.now();

  if (!allowedTools.has(call.name)) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: `Tool not allowed: ${call.name}` }),
      durationMs: Date.now() - start,
      error: `Tool not allowed: ${call.name}`,
    };
  }

  const tool = tools.get(call.name);
  if (!tool) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: `Tool not found: ${call.name}` }),
      durationMs: Date.now() - start,
      error: `Tool not found: ${call.name}`,
    };
  }

  // Role-based tool access control (if workspace context available)
  if (ctx.workspaceId) {
    try {
      const role = await getWorkspaceRole(ctx.uid, ctx.workspaceId);
      if (role) {
        const toolRisk = getToolRiskLevel(call.name);
        if (!canRoleExecuteTool(role, toolRisk)) {
          const msg = `Role "${role}" cannot execute "${toolRisk}" tool "${call.name}"`;
          logger.warn(`RBAC blocked: uid=${ctx.uid} role=${role} tool=${call.name} risk=${toolRisk}`);
          return {
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ error: msg }),
            durationMs: Date.now() - start,
            error: msg,
          };
        }
      }
    } catch (err) {
      logger.error("RBAC role check failed:", (err as Error).message);
      // Fail-open: if role lookup fails, proceed (avoid breaking tool execution)
    }
  }

  // Rate limiting for all tools (per-user sliding window)
  const rateLimitError = checkToolRateLimit(call.name, ctx.uid);
  if (rateLimitError) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: rateLimitError }),
      durationMs: Date.now() - start,
      error: rateLimitError,
    };
  }

  // Audit logging for high-risk tools
  if (HIGH_RISK_TOOLS.has(call.name)) {
    logger.info(`[HIGH-RISK] uid=${ctx.uid} tool=${call.name} args=${call.arguments.slice(0, 200)}`);
  }

  // Check cache before executing
  if (shouldCache(call.name)) {
    const cached = getCachedResult(call.name, call.arguments);
    if (cached) {
      return {
        toolCallId: call.id,
        name: call.name,
        content: cached,
        durationMs: Date.now() - start,
      };
    }
  }

  // Async tool: insert task and return taskId immediately
  if (tool.async) {
    const pool = (await import("../config/postgres.js")).getPool();
    const { randomUUID } = await import("node:crypto");
    const taskId = randomUUID();
    const params = JSON.parse(call.arguments);

    // Insert task record
    await pool.query(
      `INSERT INTO tool_tasks (id, session_id, tool_name, params, status)
       VALUES ($1, $2, $3, $4::jsonb, 'running')`,
      [taskId, ctx.sessionId, call.name, call.arguments],
    );

    // Execute in background — don't await
    (async () => {
      try {
        const parsed = tool.parameters.parse(params);
        const result = await tool.execute(parsed, ctx);
        await pool.query(
          `UPDATE tool_tasks SET status = 'done', result = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(result), taskId],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await pool.query(
          `UPDATE tool_tasks SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [msg, taskId],
        );
      }
    })().catch(() => {});

    return {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ taskId, status: "running", message: `Tool running asynchronously. Poll with tool_poll({ taskId: "${taskId}" })` }),
      durationMs: Date.now() - start,
    };
  }

  try {
    let params: unknown;
    try {
      params = JSON.parse(call.arguments);
    } catch {
      const msg = `Tool "${call.name}": invalid JSON in arguments. Received: ${call.arguments.slice(0, 200)}`;
      return { toolCallId: call.id, name: call.name, content: JSON.stringify({ error: msg }), durationMs: Date.now() - start, error: msg };
    }

    let parsed: unknown;
    try {
      parsed = tool.parameters.parse(params);
    } catch (valErr) {
      const msg = valErr instanceof z.ZodError
        ? formatZodError(valErr, call.name)
        : `Tool "${call.name}" parameter error: ${valErr instanceof Error ? valErr.message : String(valErr)}`;
      return { toolCallId: call.id, name: call.name, content: JSON.stringify({ error: msg }), durationMs: Date.now() - start, error: msg };
    }

    // Feature 20: Tool guards — conditions that must pass before tool executes
    {
      const { runToolGuards } = await import("./guards.js");
      const guardResult = await runToolGuards(call.name, parsed, ctx);
      if (!guardResult.passed) {
        return {
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: guardResult.reason ?? `Tool "${call.name}" blocked by guard` }),
          durationMs: Date.now() - start,
          error: guardResult.reason ?? "blocked by guard",
        };
      }
    }

    // Feature 15: Approval gate — block execution until a human approves
    if (tool.requiresApproval) {
      const approved = await requestApproval(tool.name, parsed as Record<string, unknown>, ctx);
      if (!approved) {
        return {
          toolCallId: call.id,
          name: tool.name,
          content: JSON.stringify({ error: "Tool execution rejected by human reviewer" }),
          durationMs: Date.now() - start,
          error: "rejected",
        };
      }
    }

    // Feature 17: Per-tool retry policy
    // If retryPolicy is set, use its settings; otherwise fall back to retryable flag
    const retryPolicy = tool.retryPolicy;
    const MAX_RETRIES = retryPolicy
      ? retryPolicy.maxAttempts - 1  // maxAttempts includes the initial attempt
      : (tool.retryable ? 2 : 0);
    const baseBackoffMs = retryPolicy?.backoffMs ?? 200;
    const retryOn = retryPolicy?.retryOn;

    let lastErr: Error | undefined;
    let result: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await tool.execute(parsed, ctx);
        break; // success
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          // Feature 17: Only retry if error matches retryOn patterns (if specified)
          if (retryOn && retryOn.length > 0) {
            const errMsg = lastErr.message;
            const shouldRetry = retryOn.some((pattern) => errMsg.includes(pattern));
            if (!shouldRetry) break;
          }
          const delay = baseBackoffMs * Math.pow(2, attempt) + Math.random() * 100;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    if (lastErr && result === undefined) throw lastErr;

    // Output schema validation
    if (tool.outputSchema) {
      const validation = tool.outputSchema.safeParse(result);
      if (!validation.success) {
        logger.warn(`[tool:${call.name}] Output schema mismatch:`, validation.error.format());
      }
    }

    const content = JSON.stringify(result);

    // Emit skill telemetry if this tool belongs to a skill
    try {
      const { getSkillForTool } = await import("../skills/registry.js");
      const skillId = getSkillForTool(call.name);
      if (skillId) {
        const { getEventBus } = await import("../events/index.js");
        getEventBus().emit("skill.executed", {
          uid: ctx.uid,
          skillId,
          toolName: call.name,
          durationMs: Date.now() - start,
          error: undefined,
          timestamp: Date.now(),
        });

        // Feature 12: Record skill feedback for evolution
        try {
          const { recordSkillFeedback } = await import("../agents/skill-evolution.js");
          recordSkillFeedback(
            skillId,
            ctx.agentId,
            {
              success: true,
              duration_ms: Date.now() - start,
              rating: 5, // default successful execution gets 5 stars
            },
            { uid: ctx.uid, workspaceId: ctx.workspaceId },
          ).catch(() => {
            // fire-and-forget
          });
        } catch {
          // skill evolution not available
        }
      }
    } catch {
      // telemetry failure shouldn't block tool execution
    }

    // Cache successful results
    if (shouldCache(call.name)) {
      setCachedResult(call.name, call.arguments, content);
    }

    return {
      toolCallId: call.id,
      name: call.name,
      content,
      durationMs: Date.now() - start,
      costUsd: tool.estimatedCostUsd,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Feature 12: Record failed skill feedback
    try {
      const { getSkillForTool } = await import("../skills/registry.js");
      const skillId = getSkillForTool(call.name);
      if (skillId) {
        const { recordSkillFeedback } = await import("../agents/skill-evolution.js");
        recordSkillFeedback(
          skillId,
          ctx.agentId,
          {
            success: false,
            duration_ms: Date.now() - start,
            rating: 1, // failure defaults to 1 star
            user_comment: message,
          },
          { uid: ctx.uid, workspaceId: ctx.workspaceId },
        ).catch(() => {
          // fire-and-forget
        });
      }
    } catch {
      // skill evolution not available
    }

    return {
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify({ error: message }),
      durationMs: Date.now() - start,
      error: message,
    };
  }
}

// ── Tool Dependency Ordering (#14) ──────────────────────────────────
// Topologically sorts tool calls so that dependencies execute first.

export function topoSortToolCalls(
  calls: Array<{ id: string; name: string; arguments: string }>,
): Array<{ id: string; name: string; arguments: string }> {
  // Build adjacency: if tool A dependsOn tool B and B is in this call set, A comes after B
  const nameToCall = new Map(calls.map((c) => [c.name, c]));
  const visited = new Set<string>();
  const result: Array<{ id: string; name: string; arguments: string }> = [];

  function visit(call: { id: string; name: string; arguments: string }) {
    if (visited.has(call.id)) return;
    visited.add(call.id);
    const tool = tools.get(call.name);
    for (const dep of tool?.dependsOn ?? []) {
      const depCall = nameToCall.get(dep);
      if (depCall) visit(depCall);
    }
    result.push(call);
  }

  for (const call of calls) {
    visit(call);
  }
  return result;
}

// ── Batch Tool Execution (#13) ───────────────────────────────────────
// If all calls target the same batchable tool, delegates to executeBatch.

export async function executeBatchIfPossible(
  calls: Array<{ id: string; name: string; arguments: string }>,
  ctx: ToolContext,
  allowedTools: Set<string>,
): Promise<Map<string, ToolResult> | null> {
  // Group calls by tool name, check if all are same batchable tool
  if (calls.length < 2) return null;
  const firstName = calls[0]!.name;
  if (!calls.every((c) => c.name === firstName)) return null;

  const tool = tools.get(firstName);
  if (!tool?.batchable || !tool.executeBatch || !allowedTools.has(firstName)) return null;

  const start = Date.now();
  try {
    const allParams = calls.map((c) => tool.parameters.parse(JSON.parse(c.arguments)));
    const results = await tool.executeBatch(allParams, ctx);
    const resultMap = new Map<string, ToolResult>();
    calls.forEach((call, i) => {
      resultMap.set(call.id, {
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(results[i]),
        durationMs: Date.now() - start,
        costUsd: tool.estimatedCostUsd,
      });
    });
    return resultMap;
  } catch {
    return null; // Fall back to individual execution
  }
}
