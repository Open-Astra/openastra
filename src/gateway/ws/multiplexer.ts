import type { WebSocket } from "ws";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ws-multiplexer");

// Per-user WebSocket registry: uid → Set of active WebSocket connections
const userConnections = new Map<string, Set<WebSocket>>();

export function subscribe(uid: string, ws: WebSocket): void {
  if (!userConnections.has(uid)) {
    userConnections.set(uid, new Set());
  }
  userConnections.get(uid)!.add(ws);
  log.info(`WS: user ${uid} subscribed (total: ${userConnections.get(uid)!.size})`);
}

export function unsubscribe(uid: string, ws: WebSocket): void {
  const connections = userConnections.get(uid);
  if (!connections) return;
  connections.delete(ws);
  if (connections.size === 0) {
    userConnections.delete(uid);
  }
}

export function broadcast(uid: string, event: Record<string, unknown>): void {
  const connections = userConnections.get(uid);
  if (!connections || connections.size === 0) return;
  const message = JSON.stringify(event);
  for (const ws of connections) {
    if (ws.readyState === 1) { // OPEN
      ws.send(message);
    } else {
      connections.delete(ws);
    }
  }
}

export function getConnectionCount(uid: string): number {
  return userConnections.get(uid)?.size ?? 0;
}
