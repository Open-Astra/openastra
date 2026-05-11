import { getPool } from "../config/postgres.js";

// ── Token Usage Types ───────────────────────────────────────────────

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
}

export interface AgentUsageBucket {
  prompt: number;
  completion: number;
  total: number;
  count: number;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  requestCount: number;
  byAgent: Record<string, AgentUsageBucket>;
  updatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getMonthKey(date?: Date): string {
  const d = date ?? new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// ── Track Token Usage ───────────────────────────────────────────────
// Atomic upsert into billing_usage table using ON CONFLICT.

export async function trackTokenUsage(
  uid: string,
  agentId: string,
  usage: TokenUsage,
  _sessionId: string,
  workspaceId?: string,
): Promise<void> {
  const pool = getPool();
  const monthKey = getMonthKey();

  // Build the per-agent update for the JSONB byAgent column
  const agentBucket = {
    prompt: usage.prompt,
    completion: usage.completion,
    total: usage.total,
    count: 1,
    ...(usage.cached ? { cached: usage.cached } : {}),
  };

  await pool.query(
    `INSERT INTO billing_usage
       (user_id, workspace_id, month, total_prompt_tokens, total_completion_tokens,
        total_tokens, total_cached_tokens, request_count, by_agent, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, jsonb_build_object($8::text, $9::jsonb), NOW())
     ON CONFLICT (user_id, month, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET
       total_prompt_tokens = billing_usage.total_prompt_tokens + $4,
       total_completion_tokens = billing_usage.total_completion_tokens + $5,
       total_tokens = billing_usage.total_tokens + $6,
       total_cached_tokens = billing_usage.total_cached_tokens + $7,
       request_count = billing_usage.request_count + 1,
       by_agent = CASE
         WHEN billing_usage.by_agent ? $8
         THEN jsonb_set(
           billing_usage.by_agent,
           ARRAY[$8],
           jsonb_build_object(
             'prompt', COALESCE((billing_usage.by_agent->$8->>'prompt')::bigint, 0) + $4,
             'completion', COALESCE((billing_usage.by_agent->$8->>'completion')::bigint, 0) + $5,
             'total', COALESCE((billing_usage.by_agent->$8->>'total')::bigint, 0) + $6,
             'count', COALESCE((billing_usage.by_agent->$8->>'count')::int, 0) + 1
           )
         )
         ELSE billing_usage.by_agent || jsonb_build_object($8::text, $9::jsonb)
       END,
       updated_at = NOW()`,
    [
      uid,
      workspaceId ?? null,
      monthKey,
      usage.prompt,
      usage.completion,
      usage.total,
      usage.cached ?? 0,
      agentId,
      JSON.stringify(agentBucket),
    ],
  );
}

// ── Get Usage Summary ───────────────────────────────────────────────

export async function getUsageSummary(
  uid: string,
  month?: string,
  workspaceId?: string,
): Promise<UsageSummary> {
  const pool = getPool();
  const monthKey = month ?? getMonthKey();

  const { rows } = await pool.query<{
    total_prompt_tokens: string;
    total_completion_tokens: string;
    total_tokens: string;
    request_count: number;
    by_agent: Record<string, AgentUsageBucket>;
    updated_at: string;
  }>(
    `SELECT total_prompt_tokens, total_completion_tokens, total_tokens,
            request_count, by_agent, updated_at
     FROM billing_usage
     WHERE user_id = $1 AND month = $2
       AND workspace_id IS NOT DISTINCT FROM $3`,
    [uid, monthKey, workspaceId ?? null],
  );

  if (rows.length === 0) {
    return {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      byAgent: {},
      updatedAt: new Date().toISOString(),
    };
  }

  const data = rows[0]!;
  return {
    totalPromptTokens: parseInt(String(data.total_prompt_tokens), 10),
    totalCompletionTokens: parseInt(String(data.total_completion_tokens), 10),
    totalTokens: parseInt(String(data.total_tokens), 10),
    requestCount: data.request_count,
    byAgent: data.by_agent ?? {},
    updatedAt: data.updated_at?.toString() ?? new Date().toISOString(),
  };
}
