import { randomUUID } from "node:crypto";
import type { InferenceClient, ChatMessage } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { createLogger } from "../utils/logger.js";

// ── Goal Decomposition ─────────────────────────────────────────────
// Breaks a high-level goal into sub-goals using an inference call,
// then matches sub-goals to agents based on their descriptions and
// skills. Designed to be wired into the orchestrator as an optional
// strategy for task planning.

const log = createLogger("goal-decomposer");

// ── Types ───────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  description: string;
  subGoals?: Goal[];
  assignedAgent?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string;
}

interface DecompositionResponse {
  subGoals: Array<{
    description: string;
    requiredCapabilities: string[];
  }>;
}

// ── Decompose Goal ──────────────────────────────────────────────────
// Uses an inference call to break a high-level goal into sub-goals.

export async function decomposeGoal(
  goal: string,
  availableAgents: AgentConfig[],
  client: InferenceClient,
): Promise<Goal> {
  const rootGoal: Goal = {
    id: randomUUID(),
    description: goal,
    status: "pending",
  };

  // Build the agent capability summary for the LLM
  const agentSummaries = availableAgents.map((a) => ({
    id: a.id,
    name: a.displayName,
    skills: a.skills,
    tools: a.tools.allow.slice(0, 10), // truncate for context
    systemPromptSnippet: a.systemPromptTemplate.slice(0, 200),
  }));

  const systemPrompt = `You are a goal decomposition engine. Given a high-level goal and a list of available agents with their capabilities, break the goal into concrete sub-goals that can be assigned to individual agents.

Rules:
1. Each sub-goal should be achievable by a single agent
2. Sub-goals should be as independent as possible
3. Include 2-6 sub-goals (prefer fewer, well-scoped goals)
4. Each sub-goal should list the capabilities it requires

Respond ONLY with valid JSON matching this schema:
{
  "subGoals": [
    {
      "description": "string — what this sub-goal achieves",
      "requiredCapabilities": ["string — skill/tool names or capability keywords"]
    }
  ]
}`;

  const userMessage = `Goal: ${goal}

Available agents:
${JSON.stringify(agentSummaries, null, 2)}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.chat({
      messages,
      temperature: 0.3,
      maxTokens: 1024,
    });

    if (!response.content) {
      log.warn("Empty response from decomposition inference");
      // Return root goal with no sub-goals
      return rootGoal;
    }

    // Parse the JSON response
    let parsed: DecompositionResponse;
    try {
      // Strip markdown code fences if present
      let jsonStr = response.content.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(jsonStr) as DecompositionResponse;
    } catch {
      log.warn("Failed to parse decomposition response as JSON");
      return rootGoal;
    }

    if (!Array.isArray(parsed.subGoals) || parsed.subGoals.length === 0) {
      return rootGoal;
    }

    // Convert sub-goals into Goal objects
    rootGoal.subGoals = parsed.subGoals.map((sg) => ({
      id: randomUUID(),
      description: sg.description,
      status: "pending" as const,
    }));

    // Assign agents to sub-goals
    const assignments = assignGoalsToAgents(rootGoal, availableAgents);
    for (const [agentId, goals] of assignments) {
      for (const g of goals) {
        g.assignedAgent = agentId;
      }
    }

    return rootGoal;
  } catch (err) {
    log.error("Goal decomposition failed:", err);
    return rootGoal;
  }
}

// ── Assign Goals to Agents ──────────────────────────────────────────
// Matches sub-goals to agents based on keyword overlap between the
// goal description and each agent's skills, tool names, and prompt.

export function assignGoalsToAgents(
  rootGoal: Goal,
  agents: AgentConfig[],
): Map<string, Goal[]> {
  const assignments = new Map<string, Goal[]>();

  if (!rootGoal.subGoals || rootGoal.subGoals.length === 0) {
    return assignments;
  }

  for (const subGoal of rootGoal.subGoals) {
    const bestAgent = findBestAgent(subGoal.description, agents);
    if (bestAgent) {
      subGoal.assignedAgent = bestAgent.id;
      const existing = assignments.get(bestAgent.id) ?? [];
      existing.push(subGoal);
      assignments.set(bestAgent.id, existing);
    }
  }

  return assignments;
}

// ── Agent Matching ──────────────────────────────────────────────────
// Scores each agent against the goal description using keyword overlap.

function findBestAgent(
  goalDescription: string,
  agents: AgentConfig[],
): AgentConfig | null {
  if (agents.length === 0) return null;

  const goalWords = tokenize(goalDescription);
  let bestScore = 0;
  let bestAgent: AgentConfig | null = null;

  for (const agent of agents) {
    // Build agent's keyword set from its identity
    const agentWords = new Set<string>();

    // Agent name and ID
    for (const w of tokenize(agent.displayName)) agentWords.add(w);
    for (const w of tokenize(agent.id)) agentWords.add(w);

    // Skills
    for (const skill of agent.skills) {
      for (const w of tokenize(skill)) agentWords.add(w);
    }

    // Tools (allow list)
    for (const tool of agent.tools.allow) {
      for (const w of tokenize(tool)) agentWords.add(w);
    }

    // System prompt keywords (first 500 chars)
    const promptSnippet = agent.systemPromptTemplate.slice(0, 500);
    for (const w of tokenize(promptSnippet)) agentWords.add(w);

    // Score = number of goal words that appear in agent's keywords
    let score = 0;
    for (const word of goalWords) {
      if (agentWords.has(word)) score++;
    }

    // Normalize by goal word count to get a relevance ratio
    const normalizedScore = goalWords.length > 0 ? score / goalWords.length : 0;

    if (normalizedScore > bestScore) {
      bestScore = normalizedScore;
      bestAgent = agent;
    }
  }

  return bestAgent;
}

// ── Tokenizer ───────────────────────────────────────────────────────
// Splits text into lowercase words, strips punctuation, filters short words.

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, " ")
    .split(/[\s_-]+/)
    .filter((w) => w.length >= 3);
}
