import { z } from "zod";
import { WebSocket } from "ws";
import type { AuthenticatedSocket } from "./ws.js";
import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import type { SessionSurface } from "../sessions/types.js";
import { runAgentLoopStream } from "../agents/loop-stream.js";
import { getAgentConfig } from "../config/agents.js";
import { resolveAgentForWorkspace } from "../agents/config-store.js";
import { trackTokenUsage } from "../billing/tracker.js";
import { handleCommand } from "./commands.js";
import { getMemberRole } from "../workspaces/store.js";

// ── Inbound Frame Schemas ───────────────────────────────────────────

const MessageFrame = z.object({
  type: z.literal("message"),
  id: z.string(),
  agentId: z.string().default("chad"),
  message: z.string().min(1).max(10000),
  surface: z.enum(["chat", "prop", "group"]).default("chat"),
  surfaceId: z.string().default("main"),
  workspaceId: z.string().optional(),
});

const PingFrame = z.object({
  type: z.literal("ping"),
});

const InboundFrame = z.discriminatedUnion("type", [MessageFrame, PingFrame]);

// ── Per-Socket State ────────────────────────────────────────────────

const activeRequests = new WeakMap<AuthenticatedSocket, AbortController>();

// Back-pressure threshold: pause stream when buffered > 64KB
const BACK_PRESSURE_THRESHOLD = 64 * 1024;

// ── Rate Limiting ───────────────────────────────────────────────────

const wsRateStore = new Map<string, number[]>();
const WS_RATE_WINDOW = 60_000;
const WS_RATE_MAX = 30;

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of wsRateStore) {
    const filtered = timestamps.filter((ts) => now - ts < WS_RATE_WINDOW);
    if (filtered.length === 0) wsRateStore.delete(key);
    else wsRateStore.set(key, filtered);
  }
}, WS_RATE_WINDOW).unref();

function checkWsRate(uid: string): boolean {
  const now = Date.now();
  let timestamps = wsRateStore.get(uid);
  if (!timestamps) {
    timestamps = [];
    wsRateStore.set(uid, timestamps);
  }
  // Slide window
  const filtered = timestamps.filter((ts) => now - ts < WS_RATE_WINDOW);
  wsRateStore.set(uid, filtered);

  if (filtered.length >= WS_RATE_MAX) return false;
  filtered.push(now);
  return true;
}

// ── Outbound Helpers ────────────────────────────────────────────────

function sendFrame(socket: AuthenticatedSocket, frame: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

// ── Handler Setup ───────────────────────────────────────────────────

export function setupWsHandler(
  socket: AuthenticatedSocket,
  resolveClient: (config: AgentConfig) => InferenceClient,
): void {
  socket.on("message", async (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      sendFrame(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    const parsed = InboundFrame.safeParse(data);
    if (!parsed.success) {
      sendFrame(socket, { type: "error", message: "Invalid frame", details: parsed.error.format() });
      return;
    }

    const frame = parsed.data;

    if (frame.type === "ping") {
      sendFrame(socket, { type: "pong", timestamp: Date.now() });
      return;
    }

    // Rate check
    if (!checkWsRate(socket.uid)) {
      sendFrame(socket, {
        type: "error",
        id: frame.id,
        message: "Rate limit exceeded",
      });
      return;
    }

    // Max 1 concurrent agent request per socket
    if (activeRequests.has(socket)) {
      sendFrame(socket, {
        type: "error",
        id: frame.id,
        message: "A request is already in progress. Wait for it to complete.",
      });
      return;
    }

    // Handle message frame
    await handleMessageFrame(socket, frame, resolveClient);
  });

  // Cleanup on disconnect
  socket.on("close", () => {
    const controller = activeRequests.get(socket);
    if (controller) {
      controller.abort();
      activeRequests.delete(socket);
    }
  });
}

// ── Process Message Frame ───────────────────────────────────────────

async function handleMessageFrame(
  socket: AuthenticatedSocket,
  frame: z.infer<typeof MessageFrame>,
  resolveClient: (config: AgentConfig) => InferenceClient,
): Promise<void> {
  const { uid } = socket;
  const { id, agentId, message, surface, surfaceId } = frame;
  const sessionKey = { uid, surface: surface as SessionSurface, surfaceId };

  // Check for slash commands
  const cmdResult = await handleCommand(message, uid, agentId, sessionKey);
  if (cmdResult) {
    sendFrame(socket, {
      type: "stream_done",
      id,
      content: cmdResult.content,
      sessionId: null,
      usage: null,
    });
    return;
  }

  let agentConfig: AgentConfig;
  try {
    agentConfig = getAgentConfig(agentId);
  } catch {
    sendFrame(socket, { type: "error", id, message: `Unknown agent: ${agentId}` });
    return;
  }

  // Enforce workspace isolation when a workspaceId is provided
  if (frame.workspaceId) {
    // Verify the user is actually a member of this workspace
    const role = await getMemberRole(frame.workspaceId, uid);
    if (!role) {
      sendFrame(socket, { type: "error", id, message: "Not a member of this workspace" });
      return;
    }

    const resolved = await resolveAgentForWorkspace(agentId, agentConfig, frame.workspaceId);
    if (!resolved) {
      sendFrame(socket, { type: "error", id, message: "Agent not accessible in this workspace" });
      return;
    }
    agentConfig = resolved.config;
  }

  const inferenceClient = resolveClient(agentConfig);
  const controller = new AbortController();
  activeRequests.set(socket, controller);

  try {
    const stream = runAgentLoopStream(
      uid,
      message,
      agentConfig,
      inferenceClient,
      sessionKey,
      controller.signal,
    );

    for await (const event of stream) {
      if (socket.readyState !== WebSocket.OPEN) break;

      // Back-pressure: wait for drain if buffer is full
      if (socket.bufferedAmount > BACK_PRESSURE_THRESHOLD) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (socket.bufferedAmount <= BACK_PRESSURE_THRESHOLD || socket.readyState !== WebSocket.OPEN) {
              resolve();
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        });
      }

      switch (event.type) {
        case "session_resolved":
          sendFrame(socket, { type: "session_resolved", id, sessionId: event.sessionId, isNew: event.isNew });
          break;

        case "stream_delta":
          sendFrame(socket, { type: "stream_chunk", id, content: event.content });
          break;

        case "tool_call_start":
          sendFrame(socket, { type: "tool_call", id, index: event.index, toolCallId: event.id, name: event.name });
          break;
        case "tool_call_complete":
          sendFrame(socket, { type: "tool_call", id, index: event.index, toolCallId: event.id, name: event.name, arguments: event.arguments, complete: true });
          break;

        case "tool_result":
          sendFrame(socket, { type: "tool_result", id, name: event.name, durationMs: event.durationMs, error: event.error });
          break;

        case "completed":
          sendFrame(socket, {
            type: "stream_done",
            id,
            content: event.content,
            sessionId: event.sessionId,
            usage: event.tokenUsage,
            toolsUsed: event.toolResults,
          });

          // Fire-and-forget token tracking
          trackTokenUsage(uid, agentId, event.tokenUsage, event.sessionId).catch(() => {});
          break;

        case "error":
          sendFrame(socket, { type: "error", id, message: event.message });
          break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent processing failed";
    sendFrame(socket, { type: "error", id, message });
  } finally {
    activeRequests.delete(socket);
  }
}
