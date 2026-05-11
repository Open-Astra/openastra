import { randomUUID } from "node:crypto";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("interrupts");

// ── Types ────────────────────────────────────────────────────────────

export interface InterruptRequest {
  id: string;
  interruptingAgentId: string;
  targetAgentId: string;
  workspaceId: string;
  reason: string;
  priority: number;
  createdAt: number;
}

export interface InterruptSignal {
  interrupted: boolean;
  by?: string;
  reason?: string;
}

// ── In-Memory Store ──────────────────────────────────────────────────
// Keyed by `${workspaceId}:${targetAgentId}`

const activeInterrupts = new Map<string, InterruptRequest>();

function key(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

// ── Public API ───────────────────────────────────────────────────────

export function requestInterrupt(
  workspaceId: string,
  interruptingAgentId: string,
  targetAgentId: string,
  reason: string,
  priority: number,
): InterruptRequest {
  const k = key(workspaceId, targetAgentId);
  const existing = activeInterrupts.get(k);

  // Only succeed if no existing interrupt or new priority is higher
  if (existing && existing.priority >= priority) {
    throw new Error(
      `Cannot interrupt: existing interrupt from ${existing.interruptingAgentId} has priority ${existing.priority} >= ${priority}`,
    );
  }

  const interrupt: InterruptRequest = {
    id: randomUUID(),
    interruptingAgentId,
    targetAgentId,
    workspaceId,
    reason,
    priority,
    createdAt: Date.now(),
  };

  activeInterrupts.set(k, interrupt);

  const bus = getEventBus();
  bus.emit("agent.started" as any, {
    type: "agent.interrupt.requested",
    interruptId: interrupt.id,
    interruptingAgentId,
    targetAgentId,
    workspaceId,
    reason,
    priority,
    timestamp: Date.now(),
  } as any);

  log.info(`Interrupt requested: ${interruptingAgentId} → ${targetAgentId} (priority ${priority})`);
  return interrupt;
}

export function checkInterrupt(agentId: string, workspaceId: string): InterruptSignal {
  const k = key(workspaceId, agentId);
  const interrupt = activeInterrupts.get(k);

  if (interrupt) {
    return {
      interrupted: true,
      by: interrupt.interruptingAgentId,
      reason: interrupt.reason,
    };
  }

  return { interrupted: false };
}

export function clearInterrupt(agentId: string, workspaceId: string): void {
  const k = key(workspaceId, agentId);
  const existed = activeInterrupts.delete(k);

  if (existed) {
    const bus = getEventBus();
    bus.emit("agent.started" as any, {
      type: "agent.interrupt.cleared",
      agentId,
      workspaceId,
      timestamp: Date.now(),
    } as any);
    log.info(`Interrupt cleared for agent ${agentId} in workspace ${workspaceId}`);
  }
}

export function getActiveInterrupts(workspaceId: string): InterruptRequest[] {
  const result: InterruptRequest[] = [];
  for (const interrupt of activeInterrupts.values()) {
    if (interrupt.workspaceId === workspaceId) {
      result.push(interrupt);
    }
  }
  return result;
}
