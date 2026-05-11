import { updatePresence } from "../gateway/presence.js";

// ── Agent Lifecycle Events ──────────────────────────────────────────
// Emit functions that update presence state at each stage of
// agent execution. Called from loop.ts and loop-stream.ts.

export function emitAgentStarted(uid: string, agentId: string, sessionId: string): void {
  updatePresence(uid, agentId, sessionId, "starting");
}

export function emitAgentStreaming(uid: string, agentId: string, sessionId: string): void {
  updatePresence(uid, agentId, sessionId, "streaming");
}

export function emitToolCallStart(uid: string, agentId: string, sessionId: string, toolName: string): void {
  updatePresence(uid, agentId, sessionId, "tool_calling", toolName);
}

export function emitToolCallEnd(uid: string, agentId: string, sessionId: string): void {
  updatePresence(uid, agentId, sessionId, "streaming");
}

export function emitAgentCompleted(uid: string, agentId: string, sessionId: string): void {
  updatePresence(uid, agentId, sessionId, "completed");
}

export function emitAgentError(uid: string, agentId: string, sessionId: string): void {
  updatePresence(uid, agentId, sessionId, "error");
}
