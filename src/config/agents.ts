import type { AgentConfig } from "../agents/types.js";

// ── Agent Runtime Registry ──────────────────────────────────────────
// Mutable map — agents are registered dynamically via the config-store
// (loaded from Postgres on startup) or via the REST API at runtime.
// No built-in agents are seeded. The map starts empty.

const AGENT_CONFIGS = new Map<string, AgentConfig>();

export function registerAgentConfig(id: string, config: AgentConfig): void {
  AGENT_CONFIGS.set(id, config);
}

export function unregisterAgentConfig(id: string): boolean {
  return AGENT_CONFIGS.delete(id);
}

export function getAgentConfig(agentId: string): AgentConfig {
  const config = AGENT_CONFIGS.get(agentId);
  if (!config) throw new Error(`Unknown agent: ${agentId}`);
  return config;
}

export function getAllAgentConfigs(): Map<string, AgentConfig> {
  return AGENT_CONFIGS;
}
