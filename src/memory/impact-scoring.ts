// -- Memory Impact Scoring
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
const logger = createLogger("memory-impact-scoring");

export interface ImpactScore {
  memoryId: string; tier: string; timesRetrieved: number;
  timesCited: number; timesInfluencedResponse: number;
  avgPosition: number | null; impactScore: number;
}

export interface ImpactStats {
  totalMemories: number; totalRetrievals: number;
  totalCitations: number; totalInfluences: number;
  avgScore: number; maxScore: number; minScore: number;
}

export function computeImpactScore(retrieved: number, cited: number, influenced: number, avgPosition: number | null): number {
  const positionBonus = avgPosition != null && avgPosition > 0 ? 1 / avgPosition : 0;
  return Math.round((influenced * 0.4 + cited * 0.3 + retrieved * 0.2 + positionBonus * 0.1) * 1000) / 1000;
}
// next part
export async function recordRetrieval(workspaceId: string, memoryId: string, tier: string, positionInContext: number | null = null): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO memory_impact_scores (workspace_id, memory_id, memory_tier, times_retrieved, last_retrieval_at, avg_position_in_context, impact_score) VALUES ($1, $2, $3, 1, NOW(), $4, 0) ON CONFLICT (workspace_id, memory_id, memory_tier) DO UPDATE SET times_retrieved = memory_impact_scores.times_retrieved + 1, last_retrieval_at = NOW(), updated_at = NOW()`,
    [workspaceId, memoryId, tier, positionInContext]);
  logger.info(`Recorded retrieval: ${memoryId}`);
}

export async function recordCitation(workspaceId: string, memoryId: string, tier: string): Promise<void> {
  const pool = getPool();
  await pool.query(`INSERT INTO memory_impact_scores (workspace_id, memory_id, memory_tier, times_cited, last_citation_at, impact_score) VALUES ($1, $2, $3, 1, NOW(), 0) ON CONFLICT (workspace_id, memory_id, memory_tier) DO UPDATE SET times_cited = memory_impact_scores.times_cited + 1, last_citation_at = NOW(), updated_at = NOW()`, [workspaceId, memoryId, tier]);
  logger.info(`Recorded citation: ${memoryId}`);
}

export async function recordInfluence(workspaceId: string, memoryId: string, tier: string): Promise<void> {
  const pool = getPool();
  await pool.query(`INSERT INTO memory_impact_scores (workspace_id, memory_id, memory_tier, times_influenced_response, impact_score) VALUES ($1, $2, $3, 1, 0) ON CONFLICT (workspace_id, memory_id, memory_tier) DO UPDATE SET times_influenced_response = memory_impact_scores.times_influenced_response + 1, updated_at = NOW()`, [workspaceId, memoryId, tier]);
  logger.info(`Recorded influence: ${memoryId}`);
}

export async function recalculateScores(workspaceId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`UPDATE memory_impact_scores SET impact_score = (times_influenced_response * 0.4 + times_cited * 0.3 + times_retrieved * 0.2 + CASE WHEN avg_position_in_context IS NOT NULL AND avg_position_in_context > 0 THEN (1.0 / avg_position_in_context) * 0.1 ELSE 0 END), updated_at = NOW() WHERE workspace_id = $1`, [workspaceId]);
  const count = result.rowCount ?? 0;
  logger.info(`Recalculated ${count} scores for workspace=${workspaceId}`);
  return count;
}

export async function getTopImpactMemories(workspaceId: string, limit: number = 20): Promise<ImpactScore[]> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT memory_id, memory_tier, times_retrieved, times_cited, times_influenced_response, avg_position_in_context, impact_score FROM memory_impact_scores WHERE workspace_id = $1 ORDER BY impact_score DESC LIMIT $2`, [workspaceId, limit]);
  return rows.map(mapRow);
}

export async function getLowImpactMemories(workspaceId: string, threshold: number = 1.0, limit: number = 50): Promise<ImpactScore[]> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT memory_id, memory_tier, times_retrieved, times_cited, times_influenced_response, avg_position_in_context, impact_score FROM memory_impact_scores WHERE workspace_id = $1 AND impact_score < $2 ORDER BY impact_score ASC LIMIT $3`, [workspaceId, threshold, limit]);
  return rows.map(mapRow);
}

export async function getImpactStats(workspaceId: string): Promise<ImpactStats> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS total_memories, COALESCE(SUM(times_retrieved),0)::int AS total_retrievals, COALESCE(SUM(times_cited),0)::int AS total_citations, COALESCE(SUM(times_influenced_response),0)::int AS total_influences, COALESCE(AVG(impact_score),0)::real AS avg_score, COALESCE(MAX(impact_score),0)::real AS max_score, COALESCE(MIN(impact_score),0)::real AS min_score FROM memory_impact_scores WHERE workspace_id = $1`, [workspaceId]);
  const r = rows[0];
  return { totalMemories: r.total_memories, totalRetrievals: r.total_retrievals, totalCitations: r.total_citations, totalInfluences: r.total_influences, avgScore: r.avg_score, maxScore: r.max_score, minScore: r.min_score };
}

export async function getImpactScores(workspaceId: string, limit: number = 50, offset: number = 0): Promise<{ scores: ImpactScore[]; total: number }> {
  const pool = getPool();
  const [dataResult, countResult] = await Promise.all([
    pool.query(`SELECT memory_id, memory_tier, times_retrieved, times_cited, times_influenced_response, avg_position_in_context, impact_score FROM memory_impact_scores WHERE workspace_id = $1 ORDER BY impact_score DESC LIMIT $2 OFFSET $3`, [workspaceId, limit, offset]),
    pool.query(`SELECT COUNT(*)::int AS total FROM memory_impact_scores WHERE workspace_id = $1`, [workspaceId]),
  ]);
  return { scores: dataResult.rows.map(mapRow), total: countResult.rows[0]?.total ?? 0 };
}

function mapRow(r: Record<string, unknown>): ImpactScore {
  return { memoryId: r.memory_id as string, tier: r.memory_tier as string, timesRetrieved: r.times_retrieved as number,
    timesCited: r.times_cited as number, timesInfluencedResponse: r.times_influenced_response as number,
    avgPosition: r.avg_position_in_context as number | null, impactScore: r.impact_score as number };
}
