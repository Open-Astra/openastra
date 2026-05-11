// ── Agent Peer Learning ─────────────────────────────────────────────
// Extract successful strategies from one agent and share with
// struggling agents. Opportunities are stored in memory and can
// be applied to improve future agent behaviour.

import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import { getEventBus } from "../events/index.js";

export interface LearningOpportunity {
  id: string;
  workspaceId: string;
  taskType: string;
  successAgentId: string;
  failedAgentId: string;
  strategy: string;
  confidence: number;
  applied: boolean;
  createdAt: number;
}

// In-memory store keyed by workspaceId
const store = new Map<string, LearningOpportunity[]>();

/** Extract the key strategy from a successful response using an inference call. */
export async function extractStrategy(
  successContent: string,
  taskDescription: string,
  client: InferenceClient,
): Promise<string> {
  const response = await client.chat({
    messages: [
      {
        role: "system",
        content: "You are an expert at analyzing successful task completions and extracting reusable strategies.",
      },
      {
        role: "user",
        content: `Analyze this successful response to the task '${taskDescription}'. Extract the key strategy, approach, or techniques that made it successful. Be specific and actionable.\n\nResponse:\n${successContent}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 500,
  });
  return response.content ?? "No strategy extracted.";
}

/** Detect a learning opportunity by comparing a successful and failed output. */
export async function detectLearningOpportunity(
  workspaceId: string,
  successAgentId: string,
  failedAgentId: string,
  successContent: string,
  failedContent: string,
  taskDescription: string,
  client: InferenceClient,
): Promise<LearningOpportunity | null> {
  // Use inference to compare the two outputs
  const comparisonResponse = await client.chat({
    messages: [
      {
        role: "system",
        content: "You compare two agent responses to the same task. Determine if there is a clear learning opportunity. Respond with JSON: { \"hasOpportunity\": boolean, \"taskType\": string, \"confidence\": number }",
      },
      {
        role: "user",
        content: `Task: ${taskDescription}\n\nSuccessful response (Agent ${successAgentId}):\n${successContent.slice(0, 1000)}\n\nFailed response (Agent ${failedAgentId}):\n${failedContent.slice(0, 1000)}\n\nIs there a clear learning opportunity where the failed agent could benefit from the successful agent's approach?`,
      },
    ],
    temperature: 0.2,
    maxTokens: 200,
  });

  const raw = comparisonResponse.content ?? "";
  let hasOpportunity = false;
  let taskType = "general";
  let confidence = 0.5;

  try {
    // Try to extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { hasOpportunity?: boolean; taskType?: string; confidence?: number };
      hasOpportunity = parsed.hasOpportunity ?? false;
      taskType = parsed.taskType ?? "general";
      confidence = parsed.confidence ?? 0.5;
    }
  } catch {
    // If parsing fails, check for keywords
    hasOpportunity = raw.toLowerCase().includes("true") || raw.toLowerCase().includes("yes");
  }

  if (!hasOpportunity) return null;

  // Extract the actual strategy
  const strategy = await extractStrategy(successContent, taskDescription, client);

  const opportunity: LearningOpportunity = {
    id: randomUUID(),
    workspaceId,
    taskType,
    successAgentId,
    failedAgentId,
    strategy,
    confidence,
    applied: false,
    createdAt: Date.now(),
  };

  // Store it
  const existing = store.get(workspaceId) ?? [];
  existing.push(opportunity);
  store.set(workspaceId, existing);

  // Emit event
  const bus = getEventBus();
  bus.emit("agent.completed", {
    uid: "system",
    agentId: successAgentId,
    sessionId: opportunity.id,
    content: `Learning opportunity detected: ${taskType}`,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    toolResults: [],
    timestamp: Date.now(),
  });

  return opportunity;
}

/** Get learning opportunities for a workspace, optionally filtered by agent. */
export function getLearningOpportunities(
  workspaceId: string,
  agentId?: string,
): LearningOpportunity[] {
  const entries = store.get(workspaceId) ?? [];
  if (!agentId) return entries;
  return entries.filter(
    (o) => o.successAgentId === agentId || o.failedAgentId === agentId,
  );
}

/** Mark a learning opportunity as applied. */
export function markLearningApplied(opportunityId: string): void {
  for (const entries of store.values()) {
    const entry = entries.find((o) => o.id === opportunityId);
    if (entry) {
      entry.applied = true;
      return;
    }
  }
}
