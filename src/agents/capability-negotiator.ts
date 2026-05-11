// ── Agent Capability Negotiator ──────────────────────────────────────
// Finds the best agent for a given set of required tools / skills.

import { getAllAgentConfigs } from "../config/agents.js";
import { getSkillToolNames } from "../skills/registry.js";

export interface AgentCapabilities {
  agentId: string;
  tools: string[];
  skills: string[];
}

/**
 * Return the capabilities (merged tool + skill tool names) for an agent.
 */
export function getAgentCapabilities(agentId: string): AgentCapabilities {
  const agents = Array.from(getAllAgentConfigs().values());
  const config = agents.find((a) => a.id === agentId);
  if (!config) throw new Error(`Unknown agent: ${agentId}`);

  const skillTools: string[] = [];
  for (const skillId of config.skills ?? []) {
    try {
      skillTools.push(...getSkillToolNames([skillId]));
    } catch {
      // Skill not found — skip
    }
  }

  return {
    agentId,
    tools: [...new Set([...config.tools.allow, ...skillTools])],
    skills: config.skills ?? [],
  };
}

export interface NegotiationResult {
  agentId: string;
  score: number;
  missingTools: string[];
  missingSkills: string[];
}

/**
 * Find the best-matching agent for required tools and skills.
 * Returns the agent whose allow-list is the closest superset of the requirements
 * (fewest extra tools = most specific match). Returns null if no agent qualifies.
 */
export async function negotiateBestAgent(
  requiredTools: string[],
  requiredSkills: string[],
): Promise<NegotiationResult | null> {
  const agents = Array.from(getAllAgentConfigs().values());
  const candidates: NegotiationResult[] = [];

  for (const config of agents) {
    let caps: AgentCapabilities;
    try {
      caps = getAgentCapabilities(config.id);
    } catch {
      continue;
    }

    const toolSet = new Set(caps.tools);
    const skillSet = new Set(caps.skills);

    const missingTools = requiredTools.filter((t) => !toolSet.has(t));
    const missingSkills = requiredSkills.filter((s) => !skillSet.has(s));

    // Only include agents that cover all required tools and skills
    if (missingTools.length === 0 && missingSkills.length === 0) {
      // Score: penalize extra tools (prefer more specific agents)
      const extraTools = caps.tools.length - requiredTools.length;
      candidates.push({ agentId: config.id, score: -extraTools, missingTools: [], missingSkills: [] });
    } else {
      candidates.push({ agentId: config.id, score: -(missingTools.length + missingSkills.length * 2), missingTools, missingSkills });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}

// ── Find Agents with Tool (Feature 18) ──────────────────────────────
// Returns all agent IDs whose capabilities include a specific tool.

export function findAgentsWithTool(toolName: string): string[] {
  const agents = Array.from(getAllAgentConfigs().values());
  const result: string[] = [];

  for (const config of agents) {
    let caps: AgentCapabilities;
    try {
      caps = getAgentCapabilities(config.id);
    } catch {
      continue;
    }

    if (caps.tools.includes(toolName)) {
      result.push(config.id);
    }
  }

  return result;
}
