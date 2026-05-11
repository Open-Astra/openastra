// ── Inter-Agent Tool Delegation (Feature 18) ─────────────────────────
// Allows Agent A to delegate a tool call to Agent B who has the
// required skill/permission, receiving the result back.

import { randomUUID } from "node:crypto";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-delegation");

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationRequest {
  requestId: string;
  fromAgentId: string;
  fromRole: string;
  toAgentId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  timeout?: number;
}

export interface DelegationResult {
  requestId: string;
  success: boolean;
  result?: ToolResult;
  delegatedTo: string;
  durationMs: number;
  error?: string;
}

// ── Delegation History ───────────────────────────────────────────────

const MAX_HISTORY_PER_SESSION = 100;
const MAX_DELEGATION_DEPTH = 6;
const delegationHistory = new Map<string, DelegationResult[]>();

export function getDelegationHistory(
  sessionId: string,
  limit = 50,
): DelegationResult[] {
  const history = delegationHistory.get(sessionId) ?? [];
  return history.slice(-limit);
}

function recordDelegation(sessionId: string, result: DelegationResult): void {
  let history = delegationHistory.get(sessionId);
  if (!history) {
    history = [];
    delegationHistory.set(sessionId, history);
  }
  history.push(result);
  if (history.length > MAX_HISTORY_PER_SESSION) {
    delegationHistory.set(sessionId, history.slice(-MAX_HISTORY_PER_SESSION));
  }
}

interface DelegationContext {
  trail: string[];
  depth: number;
}

function normalizeDelegationTrail(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function getDelegationContext(ctx: ToolContext, fromAgentId: string): DelegationContext {
  const metadataTrail = normalizeDelegationTrail(ctx.metadata?.delegationTrail);
  const trail = [...metadataTrail];

  if (trail[trail.length - 1] !== fromAgentId) {
    trail.push(fromAgentId);
  }

  return {
    trail,
    depth: trail.length,
  };
}

export function validateDelegationTarget(
  targetAgentId: string,
  ctx: ToolContext,
  fromAgentId: string,
): { valid: boolean; reason?: string; trail: string[] } {
  const context = getDelegationContext(ctx, fromAgentId);

  if (context.depth >= MAX_DELEGATION_DEPTH) {
    return {
      valid: false,
      reason: `Delegation depth limit of ${MAX_DELEGATION_DEPTH} reached`,
      trail: context.trail,
    };
  }

  if (ctx.agentId === targetAgentId) {
    return {
      valid: false,
      reason: `Delegation loop detected: agent "${ctx.agentId}" cannot delegate back to itself`,
      trail: context.trail,
    };
  }

  if (context.trail.includes(targetAgentId)) {
    return {
      valid: false,
      reason: `Delegation loop detected: agent "${targetAgentId}" is already in the delegation trail (${context.trail.join(" -> ")})`,
      trail: context.trail,
    };
  }

  return {
    valid: true,
    trail: context.trail,
  };
}

// ── Delegation ───────────────────────────────────────────────────────

export async function delegateToolCall(
  request: DelegationRequest,
  ctx: ToolContext,
): Promise<DelegationResult> {
  const start = Date.now();

  try {
    // Find target agent
    const { findAgentsWithTool } = await import("./capability-negotiator.js");
    const { executeTool } = await import("../tools/registry.js");

    if (request.toolName === "delegate_tool_call") {
      const result: DelegationResult = {
        requestId: request.requestId,
        success: false,
        delegatedTo: request.toAgentId ?? "none",
        durationMs: Date.now() - start,
        error: "Delegating delegate_tool_call is not allowed",
      };
      recordDelegation(ctx.sessionId, result);
      return result;
    }

    let targetAgentId = request.toAgentId;
    const currentTrail = getDelegationContext(ctx, request.fromAgentId);

    if (!targetAgentId) {
      const candidates = findAgentsWithTool(request.toolName).filter(
        (candidate) => candidate !== request.fromAgentId && !currentTrail.trail.includes(candidate),
      );
      if (candidates.length === 0) {
        const result: DelegationResult = {
          requestId: request.requestId,
          success: false,
          delegatedTo: "none",
          durationMs: Date.now() - start,
          error: `No non-looping agent found with tool "${request.toolName}"`,
        };
        recordDelegation(ctx.sessionId, result);
        return result;
      }
      // Pick the first candidate (most specific match from negotiator)
      targetAgentId = candidates[0]!;
    }

    const targetCheck = validateDelegationTarget(targetAgentId, ctx, request.fromAgentId);
    if (!targetCheck.valid) {
      const result: DelegationResult = {
        requestId: request.requestId,
        success: false,
        delegatedTo: targetAgentId,
        durationMs: Date.now() - start,
        error: targetCheck.reason,
      };
      recordDelegation(ctx.sessionId, result);
      return result;
    }

    // Build tool call
    const toolCall = {
      id: randomUUID(),
      name: request.toolName,
      arguments: JSON.stringify(request.toolArgs),
    };

    // Execute with the target agent's context but requesting user's uid
    const targetCtx: ToolContext = {
      uid: ctx.uid,
      agentId: targetAgentId,
      sessionId: ctx.sessionId,
      workspaceId: ctx.workspaceId,
      traceId: ctx.traceId,
      metadata: {
        ...(ctx.metadata ?? {}),
        delegatedFrom: request.fromAgentId,
        delegatedFromRole: request.fromRole,
        delegationTrail: [...targetCheck.trail, targetAgentId],
        delegationDepth: targetCheck.trail.length + 1,
        delegationRequestId: request.requestId,
      },
    };

    const allowedTools = new Set([request.toolName]);
    const toolResult = await executeTool(toolCall, targetCtx, allowedTools);

    const delegationResult: DelegationResult = {
      requestId: request.requestId,
      success: !toolResult.error,
      result: toolResult,
      delegatedTo: targetAgentId,
      durationMs: Date.now() - start,
      error: toolResult.error,
    };

    // Emit event (fire-and-forget)
    try {
      const { getEventBus } = await import("../events/index.js");
      const bus = getEventBus();
      (bus as unknown as { emit(name: string, payload: unknown): void }).emit(
        "tool.delegated",
        {
          requestId: request.requestId,
          fromAgentId: request.fromAgentId,
          toAgentId: targetAgentId,
          toolName: request.toolName,
          success: delegationResult.success,
          durationMs: delegationResult.durationMs,
          uid: ctx.uid,
          trail: [...targetCheck.trail, targetAgentId],
          timestamp: Date.now(),
        },
      );
    } catch { /* never block */ }

    recordDelegation(ctx.sessionId, delegationResult);

    logger.info(
      `Delegated ${request.toolName} from ${request.fromAgentId} to ${targetAgentId}: ${delegationResult.success ? "success" : "failed"}`,
    );

    return delegationResult;
  } catch (err) {
    const result: DelegationResult = {
      requestId: request.requestId,
      success: false,
      delegatedTo: request.toAgentId ?? "unknown",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
    recordDelegation(ctx.sessionId, result);
    return result;
  }
}

// ── Can Delegate Check ───────────────────────────────────────────────

export async function canDelegate(toolName: string): Promise<boolean> {
  const { findAgentsWithTool } = await import("./capability-negotiator.js");
  return findAgentsWithTool(toolName).length > 0;
}
