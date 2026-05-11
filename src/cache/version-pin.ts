import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("version-pin");

// agentId → current version hash
const agentVersions = new Map<string, string>();

/**
 * Compute a version string from an agent's system prompt content.
 * The version is a short SHA-256 prefix of the prompt text.
 */
export function computeAgentVersion(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}

/**
 * Record the current version for an agent.
 * Call this when building context/assembling a prompt.
 * Returns true if the version changed since last call (stale entries should be evicted).
 */
export function updateAgentVersion(agentId: string, systemPrompt: string): boolean {
  const newVersion = computeAgentVersion(systemPrompt);
  const prevVersion = agentVersions.get(agentId);

  if (prevVersion === newVersion) return false;

  agentVersions.set(agentId, newVersion);
  if (prevVersion !== undefined) {
    log.dim(`Agent ${agentId} version changed — cache entries are now stale`);
    return true; // Caller should evict old cache entries
  }
  return false;
}

/**
 * Get the current version tag for an agent (or undefined if not yet registered).
 */
export function getAgentVersion(agentId: string): string | undefined {
  return agentVersions.get(agentId);
}

/**
 * Remove an agent's version record (e.g., when agent is deleted).
 */
export function clearAgentVersion(agentId: string): void {
  agentVersions.delete(agentId);
}
