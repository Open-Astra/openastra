// ── Swarm Retrospectives ────────────────────────────────────────────
// Automated retrospectives after multi-agent tasks. Each participating
// agent reflects on its performance, and a coordinator synthesises
// the reflections into action items.

import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import { getEventBus } from "../events/index.js";

export interface Retrospective {
  id: string;
  workspaceId: string;
  taskDescription: string;
  participants: string[];
  agentReflections: Array<{
    agentId: string;
    wentWell: string[];
    wentPoorly: string[];
    suggestions: string[];
  }>;
  synthesis: string;
  actionItems: string[];
  createdAt: number;
}

// In-memory store keyed by workspaceId
const store = new Map<string, Retrospective[]>();
// Secondary index for direct ID lookup
const byId = new Map<string, Retrospective>();

/** Run a full retrospective for a multi-agent task. */
export async function runRetrospective(
  workspaceId: string,
  taskDescription: string,
  agentResults: Array<{ agentId: string; result: string; success: boolean }>,
  coordinatorClient: InferenceClient,
  agentClients?: Map<string, InferenceClient>,
): Promise<Retrospective> {
  const id = randomUUID();
  const participants = agentResults.map((r) => r.agentId);

  // Step 1: Collect reflections from each agent
  const reflections: Retrospective["agentReflections"] = [];

  for (const agentResult of agentResults) {
    const agentClient = agentClients?.get(agentResult.agentId);

    if (agentClient) {
      // Ask the agent to reflect via inference
      const response = await agentClient.chat({
        messages: [
          {
            role: "system",
            content: "You are reflecting on a task you just completed. Respond with valid JSON only: { \"wentWell\": string[], \"wentPoorly\": string[], \"suggestions\": string[] }",
          },
          {
            role: "user",
            content: `You just completed a task: '${taskDescription}'. Your result: ${agentResult.result.slice(0, 2000)}. Reflect on: what went well, what could improve, and suggestions for the team.`,
          },
        ],
        temperature: 0.4,
        maxTokens: 500,
      });

      const raw = response.content ?? "";
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            wentWell?: string[];
            wentPoorly?: string[];
            suggestions?: string[];
          };
          reflections.push({
            agentId: agentResult.agentId,
            wentWell: Array.isArray(parsed.wentWell) ? parsed.wentWell : [],
            wentPoorly: Array.isArray(parsed.wentPoorly) ? parsed.wentPoorly : [],
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
          });
          continue;
        }
      } catch {
        // Fall through to placeholder
      }
    }

    // Placeholder reflection based on success/failure
    reflections.push({
      agentId: agentResult.agentId,
      wentWell: agentResult.success ? ["Task completed successfully"] : [],
      wentPoorly: agentResult.success ? [] : ["Task did not complete successfully"],
      suggestions: agentResult.success ? [] : ["Consider alternative approaches"],
    });
  }

  // Step 2: Coordinator synthesizes all reflections
  const coordResponse = await coordinatorClient.chat({
    messages: [
      {
        role: "system",
        content: "You are a team coordinator synthesizing retrospective reflections. Respond with valid JSON only: { \"synthesis\": string, \"actionItems\": string[] }",
      },
      {
        role: "user",
        content: `Synthesize these team reflections into a brief retrospective summary with action items.\n\nTask: ${taskDescription}\n\nReflections:\n${JSON.stringify(reflections, null, 2)}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 800,
  });

  let synthesis = "Retrospective completed.";
  let actionItems: string[] = [];

  const coordRaw = coordResponse.content ?? "";
  try {
    const jsonMatch = coordRaw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        synthesis?: string;
        actionItems?: string[];
      };
      synthesis = parsed.synthesis ?? synthesis;
      actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
    }
  } catch {
    // Use the raw text as synthesis if JSON parse fails
    if (coordRaw.length > 0) {
      synthesis = coordRaw;
    }
  }

  const retro: Retrospective = {
    id,
    workspaceId,
    taskDescription,
    participants,
    agentReflections: reflections,
    synthesis,
    actionItems,
    createdAt: Date.now(),
  };

  // Store
  const existing = store.get(workspaceId) ?? [];
  existing.push(retro);
  store.set(workspaceId, existing);
  byId.set(id, retro);

  // Emit event
  const bus = getEventBus();
  bus.emit("agent.completed", {
    uid: "system",
    agentId: "coordinator",
    sessionId: id,
    content: `Retrospective completed: ${taskDescription}`,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    toolResults: [],
    timestamp: Date.now(),
  });

  return retro;
}

/** List retrospectives for a workspace. */
export function getRetrospectives(
  workspaceId: string,
  limit?: number,
): Retrospective[] {
  const entries = store.get(workspaceId) ?? [];
  // Return newest first
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  if (limit && limit > 0) return sorted.slice(0, limit);
  return sorted;
}

/** Get a single retrospective by ID. */
export function getRetrospective(retroId: string): Retrospective | null {
  return byId.get(retroId) ?? null;
}
