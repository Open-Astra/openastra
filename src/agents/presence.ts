import { getEventBus } from "../events/index.js";

// ── Agent Presence & Status ──────────────────────────────────────────
// Ephemeral in-memory presence tracking for agents within workspaces.
// No DB needed — presence is transient and resets on process restart.

export type AgentStatus = "active" | "idle" | "processing" | "offline";

export interface AgentPresence {
  agentId: string;
  workspaceId: string;
  status: AgentStatus;
  currentTask?: string;
  lastHeartbeatAt: number;
  metadata?: Record<string, unknown>;
}

// Key: `${workspaceId}:${agentId}`
const presenceStore = new Map<string, AgentPresence>();

function presenceKey(agentId: string, workspaceId: string): string {
  return `${workspaceId}:${agentId}`;
}

/** Update (or create) presence for an agent in a workspace. */
export function updatePresence(
  agentId: string,
  workspaceId: string,
  status: AgentStatus,
  currentTask?: string,
): void {
  const key = presenceKey(agentId, workspaceId);
  const existing = presenceStore.get(key);
  const entry: AgentPresence = {
    agentId,
    workspaceId,
    status,
    currentTask,
    lastHeartbeatAt: Date.now(),
    metadata: existing?.metadata,
  };
  presenceStore.set(key, entry);

  try {
    const bus = getEventBus();
    bus.emit("presence.updated", {
      uid: agentId,
      agentId,
      sessionId: "",
      status,
      currentTool: currentTask,
      timestamp: Date.now(),
    });
  } catch {
    // event bus may not be initialized yet during startup
  }
}

/** Get all presence entries for a workspace. */
export function getPresence(workspaceId: string): AgentPresence[] {
  const results: AgentPresence[] = [];
  for (const entry of presenceStore.values()) {
    if (entry.workspaceId === workspaceId) {
      results.push(entry);
    }
  }
  return results;
}

/** Get presence for a single agent in a workspace. */
export function getAgentPresence(agentId: string, workspaceId: string): AgentPresence | null {
  return presenceStore.get(presenceKey(agentId, workspaceId)) ?? null;
}

/** Remove an agent's presence entry. */
export function removePresence(agentId: string, workspaceId: string): void {
  presenceStore.delete(presenceKey(agentId, workspaceId));
}

/** Remove stale entries older than maxAgeMs (default 60s). Returns count removed. */
export function cleanStalePresence(maxAgeMs = 60_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [key, entry] of presenceStore) {
    if (entry.lastHeartbeatAt < cutoff) {
      presenceStore.delete(key);
      removed++;
    }
  }
  return removed;
}
