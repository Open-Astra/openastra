import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { verifyAccessToken } from "../auth/jwt.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import { checkConnectionRateLimit, initMessageRateLimit, checkMessageRateLimit } from "./middleware/ws-rate-limit.js";

const log = createLogger("ws");
import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import { setupWsHandler } from "./ws-handler.js";

// ── WebSocket Gateway ───────────────────────────────────────────────
// Real-time push channel for alerts, notifications, and streaming
// agent responses. Authenticates via JWT access token passed in the
// connection URL query string.

export interface AuthenticatedSocket extends WebSocket {
  uid: string;
  alive: boolean;
}

// Active connections keyed by uid (supports multiple devices)
export const connections = new Map<string, Set<AuthenticatedSocket>>();

export function initWebSocket(
  server: HttpServer,
  resolveClient?: (config: AgentConfig) => InferenceClient,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req) => {
    const socket = ws as AuthenticatedSocket;

    // Connection rate limiting — Phase 5.1 of security audit
    if (!checkConnectionRateLimit(req)) {
      socket.close(1008, "Rate limit exceeded");
      return;
    }

    // Extract token from query: ws://host/ws?token=<jwt-access-token>
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    try {
      const { uid } = await verifyAccessToken(token);
      socket.uid = uid;
      socket.alive = true;
    } catch {
      socket.close(4003, "Invalid token");
      return;
    }

    // Register connection
    let userSockets = connections.get(socket.uid);
    if (!userSockets) {
      userSockets = new Set();
      connections.set(socket.uid, userSockets);
    }
    userSockets.add(socket);

    log.dim(`Connected: uid=${socket.uid} (${userSockets.size} device(s))`);

    getEventBus().emit("ws.connected", {
      uid: socket.uid,
      deviceCount: userSockets.size,
      timestamp: Date.now(),
    });

    // Heartbeat
    socket.on("pong", () => {
      socket.alive = true;
    });

    socket.on("close", () => {
      const sockets = connections.get(socket.uid);
      if (sockets) {
        sockets.delete(socket);
        if (sockets.size === 0) connections.delete(socket.uid);
      }
      log.dim(`Disconnected: uid=${socket.uid}`);

      getEventBus().emit("ws.disconnected", {
        uid: socket.uid,
        deviceCount: sockets?.size ?? 0,
        timestamp: Date.now(),
      });
    });

    socket.on("error", (err) => {
      log.error(`Error for uid=${socket.uid}:`, err.message);
    });

    // Initialize per-connection message rate limiting
    initMessageRateLimit(socket);

    // Wrap incoming messages with rate limit check
    const origOn = socket.on.bind(socket);
    socket.on = function (event: string, listener: (...args: unknown[]) => void) {
      if (event === "message") {
        return origOn(event, (...args: unknown[]) => {
          if (!checkMessageRateLimit(socket)) return; // connection will be closed by the limiter
          listener(...args);
        });
      }
      return origOn(event, listener);
    } as typeof socket.on;

    // Set up bidirectional message handler
    if (resolveClient) {
      setupWsHandler(socket, resolveClient);
    }

    // Send welcome
    socket.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
  });

  // Heartbeat interval — detect dead connections
  const heartbeat = setInterval(() => {
    for (const [, sockets] of connections) {
      for (const socket of sockets) {
        if (!socket.alive) {
          socket.terminate();
          sockets.delete(socket);
          continue;
        }
        socket.alive = false;
        socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();

  wss.on("close", () => clearInterval(heartbeat));

  log.active("WebSocket server initialized", "/ws");
  return wss;
}

// ── Push to User ────────────────────────────────────────────────────
// Send a real-time event to all of a user's connected devices.

export interface WsEvent {
  type:
    | "line_alert"
    | "briefing"
    | "agent_response"
    | "stream_delta"
    | "stream_done"
    | "session_resolved"
    | "stream_chunk"
    | "tool_call"
    | "tool_result"
    | "error"
    | "presence"
    | "pong";
  [key: string]: unknown;
}

export function pushToUser(uid: string, event: WsEvent): number {
  const sockets = connections.get(uid);
  if (!sockets || sockets.size === 0) return 0;

  const payload = JSON.stringify(event);
  let sent = 0;

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      sent++;
    }
  }

  return sent;
}

// ── Broadcast to All ────────────────────────────────────────────────

export function broadcast(event: WsEvent): number {
  const payload = JSON.stringify(event);
  let sent = 0;

  for (const [, sockets] of connections) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        sent++;
      }
    }
  }

  return sent;
}

export function getConnectedUserCount(): number {
  return connections.size;
}
