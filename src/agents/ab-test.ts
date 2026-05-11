import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../config/postgres.js";

// ── Agent A/B Testing ─────────────────────────────────────────────────
// Deterministic variant selection: same uid always gets same variant.
// Uses a SHA-256 hash of uid + testId to derive a stable [0,1) bucket.

export interface AbTest {
  id: string;
  workspaceId: string;
  name: string;
  agentAId: string;
  agentBId: string;
  trafficSplit: number;
  metric: string;
  status: string;
  results: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Deterministically selects which agent variant a uid should see.
 * Uses SHA-256 hash of (uid + agentAId) modulo 1.0 compared to trafficSplit.
 * trafficSplit = 0.5 means 50% see A, 50% see B.
 */
export function selectAbVariant(
  test: { agent_a_id: string; agent_b_id: string; traffic_split: number },
  uid: string,
): string {
  const hash = createHash("sha256")
    .update(`${uid}:${test.agent_a_id}`)
    .digest("hex");
  // Take first 8 hex chars → 32-bit unsigned int → normalize to [0, 1)
  const bucket = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < test.traffic_split ? test.agent_a_id : test.agent_b_id;
}

/**
 * Records a user rating result for a given A/B test and agent variant.
 * Merges rating into the results JSONB column atomically.
 */
export async function recordAbResult(
  testId: string,
  agentId: string,
  rating: number,
  pool: Pool,
): Promise<void> {
  await pool.query(
    `UPDATE agent_ab_tests
     SET results = results || jsonb_build_object(
       $2::text,
       COALESCE(results->$2::text, '{"count":0,"sum":0}'::jsonb)
         || jsonb_build_object(
              'count', (COALESCE((results->$2::text->>'count')::int, 0) + 1),
              'sum',   (COALESCE((results->$2::text->>'sum')::numeric, 0) + $3)
            )
     )
     WHERE id = $1`,
    [testId, agentId, rating],
  );
}

/**
 * Returns the single active A/B test for a workspace, or null if none.
 */
export async function getActiveAbTest(
  workspaceId: string,
  pool?: Pool,
): Promise<AbTest | null> {
  const p = pool ?? getPool();
  const { rows } = await p.query<{
    id: string;
    workspace_id: string;
    name: string;
    agent_a_id: string;
    agent_b_id: string;
    traffic_split: string;
    metric: string;
    status: string;
    results: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, workspace_id, name, agent_a_id, agent_b_id,
            traffic_split, metric, status, results, created_at
     FROM agent_ab_tests
     WHERE workspace_id = $1 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    agentAId: row.agent_a_id,
    agentBId: row.agent_b_id,
    trafficSplit: parseFloat(row.traffic_split),
    metric: row.metric,
    status: row.status,
    results: row.results,
    createdAt: row.created_at,
  };
}
