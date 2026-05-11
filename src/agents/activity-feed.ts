import { randomUUID } from "node:crypto";
import { getEventBus } from "../events/index.js";

// ── Workspace Activity Feed ──────────────────────────────────────────
// In-memory ring buffer of recent activity per workspace.
// Subscribes to bus events and aggregates them into a unified feed.

export type ActivityType =
  | "agent_started"
  | "agent_completed"
  | "tool_executed"
  | "memory_written"
  | "handoff"
  | "message_sent"
  | "error";

export interface ActivityEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  type: ActivityType;
  summary: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

const MAX_ENTRIES_PER_WORKSPACE = 500;

// workspaceId → ActivityEntry[]
const feedStore = new Map<string, ActivityEntry[]>();

// Listeners for SSE streaming — workspaceId → Set of callbacks
const sseListeners = new Map<string, Set<(entry: ActivityEntry) => void>>();

/** Record a new activity entry into the ring buffer. */
export function recordActivity(entry: Omit<ActivityEntry, "id" | "timestamp">): void {
  const full: ActivityEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: Date.now(),
  };

  let entries = feedStore.get(entry.workspaceId);
  if (!entries) {
    entries = [];
    feedStore.set(entry.workspaceId, entries);
  }

  entries.push(full);

  // Ring buffer: trim to max size
  if (entries.length > MAX_ENTRIES_PER_WORKSPACE) {
    entries.splice(0, entries.length - MAX_ENTRIES_PER_WORKSPACE);
  }

  // Notify SSE listeners for this workspace
  const listeners = sseListeners.get(entry.workspaceId);
  if (listeners) {
    for (const cb of listeners) {
      try {
        cb(full);
      } catch {
        // don't let broken listeners crash the feed
      }
    }
  }
}

/** Get the activity feed for a workspace with optional filters. */
export function getActivityFeed(
  workspaceId: string,
  opts?: { limit?: number; since?: number; types?: ActivityType[] },
): ActivityEntry[] {
  const entries = feedStore.get(workspaceId) ?? [];
  let filtered = entries;

  if (opts?.since) {
    const since = opts.since;
    filtered = filtered.filter((e) => e.timestamp > since);
  }

  if (opts?.types && opts.types.length > 0) {
    const typeSet = new Set(opts.types);
    filtered = filtered.filter((e) => typeSet.has(e.type));
  }

  // Return newest first, limited
  const limit = opts?.limit ?? 100;
  return filtered.slice(-limit).reverse();
}

/** Clear the entire feed for a workspace. */
export function clearActivityFeed(workspaceId: string): void {
  feedStore.delete(workspaceId);
}

/** Subscribe to new activity entries for a workspace (for SSE). Returns unsubscribe function. */
export function subscribeToFeed(workspaceId: string, cb: (entry: ActivityEntry) => void): () => void {
  let listeners = sseListeners.get(workspaceId);
  if (!listeners) {
    listeners = new Set();
    sseListeners.set(workspaceId, listeners);
  }
  listeners.add(cb);

  return () => {
    listeners!.delete(cb);
    if (listeners!.size === 0) {
      sseListeners.delete(workspaceId);
    }
  };
}

/** Initialize activity feed — subscribe to bus events and map them to activity entries. */
export function initActivityFeed(): void {
  const bus = getEventBus();

  bus.on("agent.started", (payload) => {
    recordActivity({
      workspaceId: "", // workspace not in event payload — use agentId context
      agentId: payload.agentId,
      type: "agent_started",
      summary: `Agent ${payload.agentId} started processing`,
      metadata: { sessionId: payload.sessionId, traceId: payload.traceId },
    });
  });

  bus.on("agent.completed", (payload) => {
    const tokenStr = payload.tokenUsage
      ? ` (${payload.tokenUsage.total} tokens)`
      : "";
    recordActivity({
      workspaceId: "",
      agentId: payload.agentId,
      type: "agent_completed",
      summary: `Agent ${payload.agentId} completed${tokenStr}`,
      metadata: {
        sessionId: payload.sessionId,
        traceId: payload.traceId,
        tokenUsage: payload.tokenUsage,
      },
    });
  });

  bus.on("tool.executed", (payload) => {
    const errorSuffix = payload.error ? ` (error: ${payload.error})` : "";
    recordActivity({
      workspaceId: "",
      agentId: payload.agentId,
      type: payload.error ? "error" : "tool_executed",
      summary: `Tool ${payload.toolName} executed in ${payload.durationMs}ms${errorSuffix}`,
      metadata: {
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        durationMs: payload.durationMs,
        error: payload.error,
      },
    });
  });

  bus.on("memory.written", (payload) => {
    recordActivity({
      workspaceId: "",
      agentId: payload.uid,
      type: "memory_written",
      summary: `Memory written: ${payload.category}`,
      metadata: { category: payload.category },
    });
  });

  bus.on("agent.message", (payload) => {
    recordActivity({
      workspaceId: "",
      agentId: payload.fromAgentId,
      type: "message_sent",
      summary: `Message from ${payload.fromAgentId} to ${payload.toAgentId}`,
      metadata: { messageId: payload.messageId, toAgentId: payload.toAgentId },
    });
  });
}
