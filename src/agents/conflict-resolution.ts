import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import type { InferenceClient } from "../inference/types.js";
import { generateEmbedding } from "../memory/embeddings.js";
import { conductVote } from "./voting.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("conflict-resolution");

// ── Types ────────────────────────────────────────────────────────────

export type ResolutionStrategy = "higher_confidence" | "user_escalation" | "vote" | "most_recent";

export interface Conflict {
  id: string;
  workspaceId: string;
  agentIds: string[];
  topic: string;
  claims: Array<{ agentId: string; content: string; confidence: number; timestamp: number }>;
  resolved: boolean;
  resolution?: { strategy: ResolutionStrategy; winner?: string; result?: string };
}

// ── In-Memory Store ──────────────────────────────────────────────────

const conflicts = new Map<string, Conflict>();

// ── Negation / Contradiction Detection ───────────────────────────────

const NEGATION_PATTERNS = [
  /\bnot\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bwon't\b/i,
  /\bcan't\b/i,
  /\bcannot\b/i,
  /\bdon't\b/i,
  /\bdoesn't\b/i,
  /\bisn't\b/i,
  /\baren't\b/i,
  /\bwasn't\b/i,
  /\bweren't\b/i,
  /\bshouldn't\b/i,
  /\bwouldn't\b/i,
  /\bimpossible\b/i,
  /\bincorrect\b/i,
  /\bfalse\b/i,
  /\bwrong\b/i,
  /\bdisagree\b/i,
  /\bhowever\b/i,
  /\bon the contrary\b/i,
  /\binstead\b/i,
  /\brather\b/i,
];

function hasContradictionSignals(a: string, b: string): boolean {
  const aNeg = NEGATION_PATTERNS.filter((p) => p.test(a)).length;
  const bNeg = NEGATION_PATTERNS.filter((p) => p.test(b)).length;
  // If one text has significantly more negation than the other, likely contradictory
  return Math.abs(aNeg - bNeg) >= 2;
}

// ── Cosine Similarity ────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Detect Conflict ──────────────────────────────────────────────────

export async function detectConflict(
  workspaceId: string,
  agentId: string,
  content: string,
  confidence: number,
  recentOutputs: Array<{ agentId: string; content: string; confidence: number; timestamp: number }>,
): Promise<Conflict | null> {
  if (recentOutputs.length === 0) return null;

  const contentEmbedding = await generateEmbedding(content);

  for (const output of recentOutputs) {
    if (output.agentId === agentId) continue;

    const outputEmbedding = await generateEmbedding(output.content);
    const similarity = cosineSimilarity(contentEmbedding, outputEmbedding);

    // Similar topic (>0.80) but check for contradiction
    if (similarity > 0.80 && hasContradictionSignals(content, output.content)) {
      const conflict: Conflict = {
        id: randomUUID(),
        workspaceId,
        agentIds: [agentId, output.agentId],
        topic: content.slice(0, 200),
        claims: [
          { agentId, content, confidence, timestamp: Date.now() },
          { agentId: output.agentId, content: output.content, confidence: output.confidence, timestamp: output.timestamp },
        ],
        resolved: false,
      };

      conflicts.set(conflict.id, conflict);

      const bus = getEventBus();
      bus.emit("agent.completed" as any, {
        type: "conflict.detected",
        conflictId: conflict.id,
        workspaceId,
        agentIds: conflict.agentIds,
        topic: conflict.topic,
        timestamp: Date.now(),
      } as any);

      log.info(`Conflict detected: ${conflict.id} between ${conflict.agentIds.join(", ")}`);
      return conflict;
    }
  }

  return null;
}

// ── Resolve Conflict ─────────────────────────────────────────────────

export async function resolveConflict(
  conflict: Conflict,
  strategy: ResolutionStrategy,
  agents?: Array<{ config: AgentConfig; client: InferenceClient }>,
): Promise<Conflict> {
  const bus = getEventBus();

  switch (strategy) {
    case "higher_confidence": {
      const sorted = [...conflict.claims].sort((a, b) => b.confidence - a.confidence);
      const winner = sorted[0];
      conflict.resolution = {
        strategy,
        winner: winner.agentId,
        result: winner.content,
      };
      conflict.resolved = true;
      break;
    }

    case "most_recent": {
      const sorted = [...conflict.claims].sort((a, b) => b.timestamp - a.timestamp);
      const winner = sorted[0];
      conflict.resolution = {
        strategy,
        winner: winner.agentId,
        result: winner.content,
      };
      conflict.resolved = true;
      break;
    }

    case "user_escalation": {
      conflict.resolution = {
        strategy,
        result: "Awaiting user decision",
      };
      // Not marking resolved — user must decide
      bus.emit("agent.completed" as any, {
        type: "conflict.escalated",
        conflictId: conflict.id,
        workspaceId: conflict.workspaceId,
        agentIds: conflict.agentIds,
        topic: conflict.topic,
        timestamp: Date.now(),
      } as any);
      break;
    }

    case "vote": {
      if (!agents || agents.length === 0) {
        throw new Error("Vote strategy requires agents to participate");
      }

      const options = conflict.claims.map((c) => `${c.agentId}: ${c.content.slice(0, 500)}`);
      const result = await conductVote(
        `Which claim is more accurate about: ${conflict.topic}`,
        options,
        agents,
        "weighted",
      );

      const winnerIndex = options.indexOf(result.winner);
      const winnerClaim = conflict.claims[winnerIndex >= 0 ? winnerIndex : 0];
      conflict.resolution = {
        strategy,
        winner: winnerClaim.agentId,
        result: winnerClaim.content,
      };
      conflict.resolved = true;
      break;
    }
  }

  conflicts.set(conflict.id, conflict);

  if (conflict.resolved) {
    bus.emit("agent.completed" as any, {
      type: "conflict.resolved",
      conflictId: conflict.id,
      workspaceId: conflict.workspaceId,
      strategy,
      winner: conflict.resolution?.winner,
      timestamp: Date.now(),
    } as any);
    log.info(`Conflict resolved: ${conflict.id} via ${strategy}`);
  }

  return conflict;
}

// ── Query Functions ──────────────────────────────────────────────────

export function getUnresolvedConflicts(workspaceId: string): Conflict[] {
  const result: Conflict[] = [];
  for (const conflict of conflicts.values()) {
    if (conflict.workspaceId === workspaceId && !conflict.resolved) {
      result.push(conflict);
    }
  }
  return result;
}

export function getConflict(conflictId: string): Conflict | null {
  return conflicts.get(conflictId) ?? null;
}
