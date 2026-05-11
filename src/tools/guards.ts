import type { ToolContext } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-guards");

// ── Types ────────────────────────────────────────────────────────────

export type ToolGuard = (toolName: string, params: unknown, ctx: ToolContext) => Promise<boolean>;

interface GuardEntry {
  guard: ToolGuard;
  description: string;
}

// ── Guard Registry ───────────────────────────────────────────────────

const guardRegistry = new Map<string, GuardEntry[]>();

export function registerToolGuard(toolName: string, guard: ToolGuard, description = "custom guard"): void {
  const existing = guardRegistry.get(toolName) ?? [];
  existing.push({ guard, description });
  guardRegistry.set(toolName, existing);
}

export function getToolGuards(toolName: string): ToolGuard[] {
  return (guardRegistry.get(toolName) ?? []).map((e) => e.guard);
}

export async function runToolGuards(
  toolName: string,
  params: unknown,
  ctx: ToolContext,
): Promise<{ passed: boolean; reason?: string }> {
  const entries = guardRegistry.get(toolName) ?? [];
  if (entries.length === 0) return { passed: true };

  for (const entry of entries) {
    let result: boolean;
    try {
      result = await entry.guard(toolName, params, ctx);
    } catch (err) {
      const reason = `Guard "${entry.description}" threw an error: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`[tool-guards] ${toolName}: ${reason}`);
      return { passed: false, reason };
    }

    if (!result) {
      const reason = `Guard "${entry.description}" blocked execution of tool "${toolName}"`;
      logger.info(`[tool-guards] ${toolName}: blocked — ${entry.description}`);
      return { passed: false, reason };
    }
  }

  return { passed: true };
}

// ── Built-in Guards ──────────────────────────────────────────────────

/**
 * Only allows tool execution during the specified UTC hour range.
 * @param allowedHoursUTC [startHour, endHour] inclusive (0-23)
 */
export function timeWindowGuard(allowedHoursUTC: [number, number]): ToolGuard {
  const [startHour, endHour] = allowedHoursUTC;
  return async (_toolName: string, _params: unknown, _ctx: ToolContext): Promise<boolean> => {
    const currentHour = new Date().getUTCHours();
    if (startHour <= endHour) {
      // Normal range e.g. [9, 17]
      return currentHour >= startHour && currentHour <= endHour;
    } else {
      // Overnight range e.g. [22, 6]
      return currentHour >= startHour || currentHour <= endHour;
    }
  };
}

/**
 * Checks ctx.metadata?.role against the required role.
 * ctx is extended with optional metadata in practice.
 */
export function userRoleGuard(requiredRole: string): ToolGuard {
  const roleHierarchy: Record<string, number> = {
    viewer: 0,
    tool_runner: 1,
    editor: 2,
    owner: 3,
    admin: 4,
  };

  return async (_toolName: string, _params: unknown, ctx: ToolContext): Promise<boolean> => {
    const ctxWithMeta = ctx as ToolContext & { metadata?: { role?: string } };
    const userRole = ctxWithMeta.metadata?.role ?? "viewer";
    const userLevel = roleHierarchy[userRole] ?? 0;
    const requiredLevel = roleHierarchy[requiredRole] ?? 0;
    return userLevel >= requiredLevel;
  };
}

// Per-tool per-user sliding window for rate limiting
const guardRateLimitMap = new Map<string, number[]>();

/**
 * Additional per-tool rate limiting (separate from the registry's per-minute limit).
 * @param maxPerHour Maximum calls allowed per hour per uid
 */
export function rateLimitGuard(maxPerHour: number): ToolGuard {
  return async (toolName: string, _params: unknown, ctx: ToolContext): Promise<boolean> => {
    const key = `guard:${ctx.uid}:${toolName}`;
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour

    let timestamps = guardRateLimitMap.get(key);
    if (!timestamps) {
      timestamps = [];
      guardRateLimitMap.set(key, timestamps);
    }

    // Prune old timestamps
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerHour) {
      return false;
    }

    timestamps.push(now);
    return true;
  };
}

// Periodic cleanup of guard rate limit entries (every 15 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of guardRateLimitMap) {
    const fresh = timestamps.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) guardRateLimitMap.delete(key);
    else guardRateLimitMap.set(key, fresh);
  }
}, 15 * 60_000).unref();
