import { EventEmitter } from "node:events";
import type {
  EventName,
  EventPayload,
  EventHandler,
  WildcardHandler,
} from "./types.js";
import { EventSchemas } from "./types.js";

// ── EventBus ────────────────────────────────────────────────────────
// System-wide typed event bus. Wraps Node's EventEmitter with:
// - Typed emit/on/once/off for compile-time safety
// - Wildcard on("*") for observability/logging
// - Async handler error isolation (bad handlers don't crash the bus)
// - Optional Zod validation in dev mode

const WILDCARD = "*";
const DEV_MODE = process.env.NODE_ENV !== "production";

export class EventBus {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  /** Emit a typed event. Validates payload in dev mode. */
  emit<K extends EventName>(eventName: K, payload: EventPayload<K>): void {
    if (DEV_MODE) {
      const schema = EventSchemas[eventName];
      if (schema) {
        const result = schema.safeParse(payload);
        if (!result.success) {
          console.error(`[event-bus] Invalid payload for "${eventName}":`, result.error.format());
        }
      }
    }

    // Emit on the specific channel
    this.emitter.emit(eventName, payload);

    // Emit on wildcard for global observers
    this.emitter.emit(WILDCARD, eventName, payload);
  }

  /** Subscribe to a specific event type. Returns unsubscribe function. */
  on<K extends EventName>(eventName: K, handler: EventHandler<K>): () => void {
    const wrapper = (payload: EventPayload<K>) => {
      Promise.resolve(handler(payload)).catch((err) => {
        console.error(`[event-bus] Handler error on "${eventName}":`, err);
      });
    };
    this.emitter.on(eventName, wrapper);
    return () => {
      this.emitter.off(eventName, wrapper);
    };
  }

  /** Subscribe to a specific event type, auto-removes after first fire. */
  once<K extends EventName>(eventName: K, handler: EventHandler<K>): () => void {
    const wrapper = (payload: EventPayload<K>) => {
      Promise.resolve(handler(payload)).catch((err) => {
        console.error(`[event-bus] Handler error on "${eventName}":`, err);
      });
    };
    this.emitter.once(eventName, wrapper);
    return () => {
      this.emitter.off(eventName, wrapper);
    };
  }

  /** Remove a specific handler (requires the exact function reference from on()). */
  off<K extends EventName>(eventName: K, handler: EventHandler<K>): void {
    this.emitter.off(eventName, handler as (...args: unknown[]) => void);
  }

  /** Subscribe to ALL events. Useful for logging, metrics, debugging. */
  onAny(handler: WildcardHandler): () => void {
    const wrapper = (eventName: EventName, payload: EventPayload<EventName>) => {
      Promise.resolve(handler(eventName, payload)).catch((err) => {
        console.error("[event-bus] Wildcard handler error:", err);
      });
    };
    this.emitter.on(WILDCARD, wrapper);
    return () => {
      this.emitter.off(WILDCARD, wrapper);
    };
  }

  /** Remove all listeners. Useful for testing and shutdown. */
  clear(): void {
    this.emitter.removeAllListeners();
  }

  /** Get the count of listeners for a specific event. */
  listenerCount(eventName: EventName | typeof WILDCARD): number {
    return this.emitter.listenerCount(eventName);
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: EventBus | undefined;

export function getEventBus(): EventBus {
  if (!_instance) {
    _instance = new EventBus();

    // Dev mode: log all events (skip in standalone CLI — too noisy for interactive use)
    if (DEV_MODE && !process.env.ASTRA_STANDALONE) {
      _instance.onAny((name, _payload) => {
        console.log(`[event-bus] ${name}`);
      });
    }
  }
  return _instance;
}
