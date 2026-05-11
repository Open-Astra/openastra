import type { Response } from "express";
import type { EventName, AnyEventPayload } from "./types.js";
import { getEventBus } from "./bus.js";
import { createLogger } from "../utils/logger.js";

// ── Event Transport Adapters ───────────────────────────────────────
// Bridges the internal EventBus to external consumers via different
// transport protocols. Each transport subscribes to the bus and
// forwards events in the appropriate format.
//
// Transports:
//   - SSE: Server-Sent Events for browser/dashboard clients
//   - Webhook Relay: POST events to external HTTP endpoints
//   - Console: Pretty-print events to stdout (for CLI/dev)

const log = createLogger("event-transport");

// ── SSE Transport ──────────────────────────────────────────────────

export interface SseClient {
  id: string;
  res: Response;
  filter?: EventName[];
  connectedAt: number;
}

export class SseTransport {
  private clients = new Map<string, SseClient>();
  private unsubscribe: (() => void) | null = null;

  start(): void {
    const bus = getEventBus();
    this.unsubscribe = bus.onAny((eventName, payload) => {
      this.broadcast(eventName, payload);
    });
    log.info("SSE transport started");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
    log.info("SSE transport stopped");
  }

  addClient(client: SseClient): void {
    this.clients.set(client.id, client);

    client.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    client.res.write(`data: ${JSON.stringify({ type: "connected", clientId: client.id })}\n\n`);

    client.res.on("close", () => {
      this.clients.delete(client.id);
    });
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.res.end();
      this.clients.delete(id);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private broadcast(eventName: EventName, payload: AnyEventPayload): void {
    const data = JSON.stringify({ event: eventName, ...payload });
    const message = `event: ${eventName}\ndata: ${data}\n\n`;

    for (const [id, client] of this.clients) {
      if (client.filter && !client.filter.includes(eventName)) continue;

      try {
        client.res.write(message);
      } catch {
        this.clients.delete(id);
      }
    }
  }
}

// ── Webhook Relay Transport ────────────────────────────────────────

export interface WebhookTarget {
  id: string;
  url: string;
  events: EventName[] | "*";
  headers?: Record<string, string>;
  secret?: string;
}

export class WebhookRelayTransport {
  private targets = new Map<string, WebhookTarget>();
  private unsubscribe: (() => void) | null = null;
  private queue: Array<{ target: WebhookTarget; eventName: EventName; payload: AnyEventPayload }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    const bus = getEventBus();
    this.unsubscribe = bus.onAny((eventName, payload) => {
      for (const target of this.targets.values()) {
        if (target.events !== "*" && !target.events.includes(eventName)) continue;
        this.queue.push({ target, eventName, payload });
      }
    });

    this.flushTimer = setInterval(() => this.flush(), 1000);
    log.info("Webhook relay transport started");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    log.info("Webhook relay transport stopped");
  }

  addTarget(target: WebhookTarget): void {
    this.targets.set(target.id, target);
  }

  removeTarget(id: string): void {
    this.targets.delete(id);
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, 50);

    for (const { target, eventName, payload } of batch) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Astra-Event": eventName,
          ...target.headers,
        };

        if (target.secret) {
          const { createHmac } = await import("node:crypto");
          const body = JSON.stringify({ event: eventName, ...payload });
          headers["X-Astra-Signature"] = createHmac("sha256", target.secret).update(body).digest("hex");
        }

        await fetch(target.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ event: eventName, ...payload }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        log.dim(`Webhook relay failed for ${target.url}: ${err}`);
      }
    }
  }
}

// ── Console Transport ──────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  "agent.started": "\x1b[32m",
  "agent.completed": "\x1b[36m",
  "tool.executed": "\x1b[33m",
  "agent.spawn.started": "\x1b[35m",
  "agent.spawn.completed": "\x1b[35m",
  "memory.written": "\x1b[34m",
  "session.created": "\x1b[36m",
  "job.failed": "\x1b[31m",
  "security.intrusion_detected": "\x1b[31m",
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export class ConsoleTransport {
  private unsubscribe: (() => void) | null = null;
  private filter: EventName[] | null = null;

  start(filter?: EventName[]): void {
    this.filter = filter ?? null;
    const bus = getEventBus();
    this.unsubscribe = bus.onAny((eventName, payload) => {
      if (this.filter && !this.filter.includes(eventName)) return;

      const color = EVENT_COLORS[eventName] ?? DIM;
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const p = payload as Record<string, unknown>;
      const agent = p.agentId ?? p.fromAgentId ?? "";
      const summary = p.content ?? p.toolName ?? p.error ?? p.status ?? "";

      console.log(`${DIM}${ts}${RESET} ${color}${eventName}${RESET} ${agent ? `[${agent}]` : ""} ${summary}`);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

// ── Singleton Access ───────────────────────────────────────────────

let _sse: SseTransport | null = null;
let _webhookRelay: WebhookRelayTransport | null = null;
let _console: ConsoleTransport | null = null;

export function getSseTransport(): SseTransport {
  if (!_sse) _sse = new SseTransport();
  return _sse;
}

export function getWebhookRelayTransport(): WebhookRelayTransport {
  if (!_webhookRelay) _webhookRelay = new WebhookRelayTransport();
  return _webhookRelay;
}

export function getConsoleTransport(): ConsoleTransport {
  if (!_console) _console = new ConsoleTransport();
  return _console;
}
