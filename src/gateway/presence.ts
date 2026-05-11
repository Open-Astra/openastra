import { pushToUser } from "./ws.js";
import { getEventBus } from "../events/index.js";

// ── Agent Presence State ────────────────────────────────────────────

export type PresenceStatus = "starting" | "streaming" | "tool_calling" | "completed" | "error";

export interface AgentPresenceState {
  agentId: string;
  sessionId: string;
  status: PresenceStatus;
  currentTool?: string;
  startedAt: number;
  lastUpdate: number;
}

// ── In-Memory Presence Store ────────────────────────────────────────
// Map<uid, Map<sessionId, AgentPresenceState>>

const presenceStore = new Map<string, Map<string, AgentPresenceState>>();

// Stale entry cleanup: remove entries not updated in 5 minutes
const STALE_THRESHOLD = 5 * 60_000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [uid, sessions] of presenceStore) {
    for (const [sessionId, state] of sessions) {
      if (now - state.lastUpdate > STALE_THRESHOLD) {
        sessions.delete(sessionId);
      }
    }
    if (sessions.size === 0) presenceStore.delete(uid);
  }
}, 60_000);
cleanupInterval.unref();

// ── Presence API ────────────────────────────────────────────────────

export function updatePresence(
  uid: string,
  agentId: string,
  sessionId: string,
  status: PresenceStatus,
  currentTool?: string,
): void {
  let sessions = presenceStore.get(uid);
  if (!sessions) {
    sessions = new Map();
    presenceStore.set(uid, sessions);
  }

  const now = Date.now();
  const existing = sessions.get(sessionId);

  const state: AgentPresenceState = {
    agentId,
    sessionId,
    status,
    currentTool,
    startedAt: existing?.startedAt ?? now,
    lastUpdate: now,
  };

  if (status === "completed" || status === "error") {
    sessions.delete(sessionId);
    if (sessions.size === 0) presenceStore.delete(uid);
  } else {
    sessions.set(sessionId, state);
  }

  // Push to user via WebSocket
  pushToUser(uid, {
    type: "presence",
    agentId,
    sessionId,
    status,
    currentTool,
    timestamp: now,
  });

  // Emit to event bus
  getEventBus().emit("presence.updated", {
    uid,
    agentId,
    sessionId,
    status,
    currentTool,
    timestamp: now,
  });
}

export function getPresence(uid: string): AgentPresenceState[] {
  const sessions = presenceStore.get(uid);
  if (!sessions) return [];
  return [...sessions.values()];
}

export function clearPresence(uid: string, sessionId: string): void {
  const sessions = presenceStore.get(uid);
  if (sessions) {
    sessions.delete(sessionId);
    if (sessions.size === 0) presenceStore.delete(uid);
  }
}
