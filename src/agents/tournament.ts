import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import type { InferenceClient } from "../inference/types.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-tournament");

// ── Types ────────────────────────────────────────────────────────────

export type ResolveClientFn = (config: AgentConfig) => InferenceClient;

export interface AgentRanking {
  agentId: string;
  avgScore: number;
  responses: Array<{ prompt: string; response: string; score: number }>;
}

export interface TournamentResult {
  tournamentId: string;
  rankings: AgentRanking[];
  winner: string;
  completedAt: number;
}

// ── Tournament Execution ─────────────────────────────────────────────

/**
 * Runs multiple agents against the same test prompts, scores them,
 * and returns a ranked leaderboard.
 *
 * Score = response length + (no error ? 100 : 0) as simple proxy metric.
 */
export async function runTournament(
  tournamentId: string,
  agentIds: string[],
  testPrompts: string[],
  resolveClient: ResolveClientFn,
): Promise<TournamentResult> {
  logger.info(`[tournament:${tournamentId.slice(0, 8)}] starting — agents=${agentIds.length} prompts=${testPrompts.length}`);

  const { getAgentConfig } = await import("../config/agents.js");
  const rankingMap = new Map<string, AgentRanking>();

  // Initialize rankings
  for (const agentId of agentIds) {
    rankingMap.set(agentId, { agentId, avgScore: 0, responses: [] });
  }

  // Run each agent against each prompt
  await Promise.all(
    agentIds.map(async (agentId) => {
      const ranking = rankingMap.get(agentId)!;
      let totalScore = 0;

      for (const prompt of testPrompts) {
        let response = "";
        let score = 0;

        try {
          const agentConfig = getAgentConfig(agentId);
          const client = resolveClient(agentConfig);

          const res = await client.chat({
            messages: [
              { role: "system", content: agentConfig.systemPromptTemplate },
              { role: "user", content: prompt },
            ],
            temperature: agentConfig.model.temperature,
            maxTokens: Math.min(agentConfig.model.maxOutputTokens, 512),
            sessionId: randomUUID(),
          });

          response = res.content ?? "";
          // Score = response length + bonus for success
          score = response.length + 100;
        } catch (err) {
          response = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          score = 0;
        }

        totalScore += score;
        ranking.responses.push({ prompt, response, score });
      }

      ranking.avgScore = testPrompts.length > 0
        ? Math.round(totalScore / testPrompts.length)
        : 0;

      logger.info(`[tournament] agent ${agentId} avgScore=${ranking.avgScore}`);
    }),
  );

  // Sort rankings by avgScore descending
  const rankings = [...rankingMap.values()].sort((a, b) => b.avgScore - a.avgScore);
  const winner = rankings[0]?.agentId ?? agentIds[0] ?? "";

  const result: TournamentResult = {
    tournamentId,
    rankings,
    winner,
    completedAt: Date.now(),
  };

  // Persist results
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE agent_tournaments
       SET status = 'completed', results = $1::jsonb, winner_agent_id = $2, completed_at = NOW()
       WHERE id = $3`,
      [JSON.stringify({ rankings }), winner, tournamentId],
    );
  } catch (err) {
    logger.warn(`[tournament] Failed to persist results: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
