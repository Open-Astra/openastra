import type { AgentConfig } from "./types.js";
import { generateEmbedding } from "../memory/embeddings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("specialization-router");

// ── Agent Specialization Routing ─────────────────────────────────────
// Routes user messages to the most specialized agent using embedding
// similarity. Agent embeddings are cached in memory since they rarely
// change.

interface RoutingResult {
  agentId: string;
  score: number;
  reasoning: string;
}

// In-memory cache for agent embeddings (agentId → embedding vector)
const agentEmbeddingCache = new Map<string, number[]>();

/**
 * Generate a descriptive text for an agent to use for embedding.
 */
function agentDescriptionText(agent: AgentConfig): string {
  const parts = [agent.displayName];
  if (agent.systemPromptTemplate) {
    // Take first 500 chars of system prompt to keep embedding focused
    parts.push(agent.systemPromptTemplate.slice(0, 500));
  }
  if (agent.skills.length > 0) {
    parts.push(agent.skills.join(" "));
  }
  return parts.join(" ");
}

/**
 * Get or compute the embedding for an agent config.
 * Cached in memory for performance.
 */
async function getAgentEmbedding(agent: AgentConfig): Promise<number[]> {
  const cached = agentEmbeddingCache.get(agent.id);
  if (cached) return cached;

  const text = agentDescriptionText(agent);
  const embedding = await generateEmbedding(text);
  agentEmbeddingCache.set(agent.id, embedding);
  return embedding;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

/**
 * Route a user message to the most specialized agent using embedding similarity.
 *
 * 1. Generates embedding for the user message
 * 2. For each agent, generates/caches an embedding from its description
 * 3. Computes cosine similarity between message and each agent
 * 4. Returns the best match with score and reasoning
 */
export async function routeToSpecialist(
  message: string,
  agents: AgentConfig[],
): Promise<RoutingResult> {
  if (agents.length === 0) {
    throw new Error("At least one agent is required for routing");
  }

  // Generate embedding for the user message
  const messageEmbedding = await generateEmbedding(message);

  // Score each agent
  const scored: Array<{ agent: AgentConfig; score: number }> = [];

  for (const agent of agents) {
    try {
      const agentEmb = await getAgentEmbedding(agent);
      const score = cosineSimilarity(messageEmbedding, agentEmb);
      scored.push({ agent, score });
    } catch (err) {
      log.warn(`Failed to compute embedding for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (scored.length === 0) {
    throw new Error("Failed to compute similarity for any agent");
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const secondBest = scored.length > 1 ? scored[1] : null;

  const reasoning = secondBest
    ? `Best match: "${best.agent.displayName}" (score: ${best.score.toFixed(3)}) vs second: "${secondBest.agent.displayName}" (score: ${secondBest.score.toFixed(3)})`
    : `Only candidate: "${best.agent.displayName}" (score: ${best.score.toFixed(3)})`;

  return {
    agentId: best.agent.id,
    score: best.score,
    reasoning,
  };
}

/**
 * Clear the agent embedding cache. Useful when agent configs are updated.
 */
export function clearAgentEmbeddingCache(): void {
  agentEmbeddingCache.clear();
}
