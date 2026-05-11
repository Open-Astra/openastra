import { z } from "zod";
import { getEventBus } from "../events/index.js";
import type { EventHandler } from "../events/index.js";
import type { AgentId } from "./types.js";

// ── Topic Names (legacy — use EventBus directly for new code) ──────

export const PubSubTopic = z.enum([
  "agent-tasks",
  "agent-results",
  "agent-messages",
]);
export type PubSubTopic = z.infer<typeof PubSubTopic>;

// ── Legacy Message Types ────────────────────────────────────────────

/** Published to agent-tasks when a parent spawns a sub-agent. */
export interface SpawnTaskMessage {
  type: "spawn_task";
  taskId: string;
  parentAgentId: AgentId;
  targetAgentId: AgentId;
  uid: string;
  task: string;
  depth: number;
  timestamp: number;
}

/** Published to agent-results when a sub-agent completes its task. */
export interface TaskResultMessage {
  type: "task_result";
  taskId: string;
  parentAgentId: AgentId;
  targetAgentId: AgentId;
  uid: string;
  content: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
}

/** Published to agent-messages for direct inter-agent communication. */
export interface AgentMessage {
  type: "agent_message";
  messageId: string;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  uid: string;
  content: string;
  timestamp: number;
}

export type PubSubMessage = SpawnTaskMessage | TaskResultMessage | AgentMessage;

export type MessageHandler<T extends PubSubMessage = PubSubMessage> = (
  message: T,
) => void | Promise<void>;

// ── PubSubBus (Deprecated — thin adapter over EventBus) ────────────
// Kept for backward compatibility with spawn.ts. New code should use
// getEventBus() from src/events/ directly.

/** @deprecated Use getEventBus() from src/events/ instead */
export class PubSubBus {
  /** Publish a message to a topic. Maps to EventBus events. */
  publish(topic: PubSubTopic, message: PubSubMessage): void {
    const bus = getEventBus();

    switch (topic) {
      case "agent-tasks": {
        const m = message as SpawnTaskMessage;
        bus.emit("agent.spawn.started", {
          taskId: m.taskId,
          parentAgentId: m.parentAgentId,
          targetAgentId: m.targetAgentId,
          uid: m.uid,
          task: m.task,
          depth: m.depth,
          timestamp: m.timestamp,
        });
        break;
      }
      case "agent-results": {
        const m = message as TaskResultMessage;
        bus.emit("agent.spawn.completed", {
          taskId: m.taskId,
          parentAgentId: m.parentAgentId,
          targetAgentId: m.targetAgentId,
          uid: m.uid,
          content: m.content,
          success: m.success,
          durationMs: m.durationMs,
          timestamp: m.timestamp,
        });
        break;
      }
      case "agent-messages": {
        const m = message as AgentMessage;
        bus.emit("agent.message", {
          messageId: m.messageId,
          fromAgentId: m.fromAgentId,
          toAgentId: m.toAgentId,
          uid: m.uid,
          content: m.content,
          timestamp: m.timestamp,
        });
        break;
      }
    }
  }

  /** Subscribe to messages on a topic. Returns an unsubscribe function. */
  subscribe<T extends PubSubMessage>(
    topic: PubSubTopic,
    handler: MessageHandler<T>,
  ): () => void {
    const bus = getEventBus();
    const topicMap: Record<PubSubTopic, "agent.spawn.started" | "agent.spawn.completed" | "agent.message"> = {
      "agent-tasks": "agent.spawn.started",
      "agent-results": "agent.spawn.completed",
      "agent-messages": "agent.message",
    };

    const eventName = topicMap[topic];
    const eventHandler: EventHandler<typeof eventName> = (payload) => {
      handler(payload as unknown as T);
    };

    return bus.on(eventName, eventHandler);
  }

  /** Remove all listeners. */
  clear(): void {
    // No-op — clearing the global bus from legacy code would be destructive.
    // Individual unsubscribe functions should be used instead.
  }
}

// ── Singleton Bus Instance ─────────────────────────────────────────

let busInstance: PubSubBus | undefined;

/** @deprecated Use getEventBus() from src/events/ instead */
export function getBus(): PubSubBus {
  if (!busInstance) {
    busInstance = new PubSubBus();
  }
  return busInstance;
}
