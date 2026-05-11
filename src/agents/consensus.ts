// ── Multi-Agent Consensus Protocols (Feature 15) ─────────────────────
// Formal consensus mechanisms beyond debate: majority vote, weighted
// vote, Delphi method, and quorum-based approval.

import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import type { InferenceClient } from "../inference/types.js";

// ── Types ────────────────────────────────────────────────────────────

export type ConsensusStrategy = "majority_vote" | "weighted_vote" | "delphi" | "quorum";

export interface ConsensusConfig {
  strategy: ConsensusStrategy;
  requiredQuorum?: number;
  maxRounds?: number;
  weightKey?: "confidence";
  threshold?: number;
  participantCount?: number;
}

export interface Vote {
  agentRole: string;
  instanceId: string;
  position: string;
  confidence: number;
  evidence?: string[];
}

export interface ConsensusResult {
  strategy: ConsensusStrategy;
  resolved: boolean;
  resolution?: string;
  votes: Vote[];
  rounds: number;
  metadata: Record<string, unknown>;
}

export type ConsensusRoundStatus = "open" | "resolved" | "failed" | "timeout";

export interface ConsensusProposal {
  topic: string;
  description?: string;
  participants: string[];
  requiredMajority?: number;
}

export interface ConsensusRoundVote {
  agentId: string;
  vote: "agree" | "disagree" | "abstain";
  reasoning: string | null;
  castAt: Date;
}

export interface ConsensusRound {
  id: string;
  workspaceId: string;
  topic: string;
  description: string | null;
  participants: string[];
  requiredMajority: number;
  status: ConsensusRoundStatus;
  result: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  votes: ConsensusRoundVote[];
}

// ── Dispatcher ───────────────────────────────────────────────────────

export async function runConsensus(
  votes: Vote[],
  config: ConsensusConfig,
  inferenceClient?: InferenceClient,
): Promise<ConsensusResult> {
  switch (config.strategy) {
    case "majority_vote":
      return majorityVote(votes);
    case "weighted_vote":
      return weightedVote(votes, config.threshold ?? 0.6);
    case "delphi":
      if (!inferenceClient) throw new Error("Delphi method requires an inference client");
      return delphiMethod(votes, config.maxRounds ?? 3, inferenceClient);
    case "quorum":
      return quorumApproval(votes, config.requiredQuorum ?? 0.5, config.participantCount);
    default:
      throw new Error(`Unknown consensus strategy: ${config.strategy}`);
  }
}

// ── Majority Vote ────────────────────────────────────────────────────

export function majorityVote(votes: Vote[]): ConsensusResult {
  if (votes.length === 0) {
    return { strategy: "majority_vote", resolved: false, votes, rounds: 1, metadata: { reason: "no votes" } };
  }

  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.position, (counts.get(v.position) ?? 0) + 1);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topCount = sorted[0]![1];
  const winners = sorted.filter(([, c]) => c === topCount);

  if (winners.length > 1) {
    return {
      strategy: "majority_vote", resolved: false, votes, rounds: 1,
      metadata: { reason: "tie", tiedPositions: winners.map(([p]) => p), voteCounts: Object.fromEntries(counts) },
    };
  }

  return {
    strategy: "majority_vote", resolved: true, resolution: sorted[0]![0], votes, rounds: 1,
    metadata: { voteCounts: Object.fromEntries(counts), winnerCount: topCount, totalVotes: votes.length },
  };
}

// ── Weighted Vote ────────────────────────────────────────────────────

export function weightedVote(votes: Vote[], threshold = 0.6): ConsensusResult {
  if (votes.length === 0) {
    return { strategy: "weighted_vote", resolved: false, votes, rounds: 1, metadata: { reason: "no votes" } };
  }

  const scores = new Map<string, number>();
  const totalWeight = votes.reduce((sum, v) => sum + v.confidence, 0);
  for (const v of votes) scores.set(v.position, (scores.get(v.position) ?? 0) + v.confidence);

  const normalized = new Map<string, number>();
  for (const [pos, score] of scores) normalized.set(pos, totalWeight > 0 ? score / totalWeight : 0);

  const sorted = [...normalized.entries()].sort((a, b) => b[1] - a[1]);
  const topScore = sorted[0]![1];

  if (topScore >= threshold) {
    return {
      strategy: "weighted_vote", resolved: true, resolution: sorted[0]![0], votes, rounds: 1,
      metadata: { weightedScores: Object.fromEntries(normalized), threshold, winnerScore: topScore },
    };
  }

  return {
    strategy: "weighted_vote", resolved: false, votes, rounds: 1,
    metadata: { weightedScores: Object.fromEntries(normalized), threshold, topScore, reason: `Top score ${topScore.toFixed(3)} below threshold` },
  };
}

// ── Delphi Method ────────────────────────────────────────────────────

export async function delphiMethod(
  initialVotes: Vote[],
  maxRounds: number,
  inferenceClient: InferenceClient,
): Promise<ConsensusResult> {
  let currentVotes = [...initialVotes];
  const allRounds: Array<{ round: number; votes: Vote[] }> = [];

  for (let round = 1; round <= maxRounds; round++) {
    allRounds.push({ round, votes: [...currentVotes] });

    const counts = new Map<string, number>();
    for (const v of currentVotes) counts.set(v.position, (counts.get(v.position) ?? 0) + 1);
    const topEntry = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

    if (topEntry && topEntry[1] / currentVotes.length > 0.7) {
      return {
        strategy: "delphi", resolved: true, resolution: topEntry[0], votes: currentVotes, rounds: round,
        metadata: { convergenceRate: topEntry[1] / currentVotes.length, allRounds, voteCounts: Object.fromEntries(counts) },
      };
    }

    if (round === maxRounds) break;

    const summary = buildAnonymousSummary(currentVotes);
    const updatedVotes: Vote[] = [];
    for (const vote of currentVotes) {
      updatedVotes.push(await reconsiderVote(vote, summary, inferenceClient));
    }
    currentVotes = updatedVotes;
  }

  const finalResult = majorityVote(currentVotes);
  return {
    strategy: "delphi", resolved: finalResult.resolved, resolution: finalResult.resolution,
    votes: currentVotes, rounds: maxRounds, metadata: { allRounds, finalVoteCounts: finalResult.metadata.voteCounts },
  };
}

function buildAnonymousSummary(votes: Vote[]): string {
  const counts = new Map<string, { count: number; avgConf: number; evidence: string[] }>();
  for (const v of votes) {
    const e = counts.get(v.position) ?? { count: 0, avgConf: 0, evidence: [] };
    e.count++;
    e.avgConf = (e.avgConf * (e.count - 1) + v.confidence) / e.count;
    if (v.evidence) e.evidence.push(...v.evidence);
    counts.set(v.position, e);
  }

  const lines = ["Anonymous Summary:"];
  for (const [pos, data] of counts) {
    lines.push(`- "${pos}" — ${data.count}/${votes.length} voters (avg confidence: ${data.avgConf.toFixed(2)})`);
    if (data.evidence.length > 0) lines.push(`  Evidence: ${data.evidence.slice(0, 5).join("; ")}`);
  }
  return lines.join("\n");
}

async function reconsiderVote(vote: Vote, summary: string, client: InferenceClient): Promise<Vote> {
  try {
    const response = await client.chat({
      messages: [
        { role: "system", content: `You are in a Delphi consensus process. Review the summary and reconsider.\nRespond in JSON: { "position": "...", "confidence": 0.0-1.0, "evidence": ["..."] }` },
        { role: "user", content: `Your previous position: "${vote.position}" (confidence: ${vote.confidence})\n\n${summary}\n\nReconsider your position.` },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });

    const jsonMatch = (response.content ?? "").match(/\{[\s\S]*\}/);
    if (!jsonMatch) return vote;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      agentRole: vote.agentRole, instanceId: vote.instanceId,
      position: String(parsed.position ?? vote.position),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? vote.confidence))),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : vote.evidence,
    };
  } catch { return vote; }
}

// ── Quorum Approval ──────────────────────────────────────────────────

export function quorumApproval(votes: Vote[], requiredQuorum: number, totalParticipants = votes.length): ConsensusResult {
  if (votes.length === 0) {
    return { strategy: "quorum", resolved: false, votes, rounds: 1, metadata: { reason: "no votes", requiredQuorum } };
  }

  const approves = votes.filter((v) => isApprove(v.position)).length;
  const rejects = votes.filter((v) => isReject(v.position)).length;
  const abstains = votes.length - approves - rejects;
  const total = votes.length;
  const approvalRate = totalParticipants > 0 ? approves / totalParticipants : 0;
  const rejectionRate = totalParticipants > 0 ? rejects / totalParticipants : 0;
  const normalizedApprovalRate = Number(approvalRate.toFixed(2));
  const normalizedRejectionRate = Number(rejectionRate.toFixed(2));
  const quorumMet = total >= totalParticipants;

  if (normalizedApprovalRate >= requiredQuorum) {
    return {
      strategy: "quorum", resolved: true, resolution: "approved", votes, rounds: 1,
      metadata: { approves, rejects, abstains, total, approvalRate, normalizedApprovalRate, requiredQuorum, totalParticipants, quorumMet },
    };
  }

  if (normalizedRejectionRate >= requiredQuorum) {
    return {
      strategy: "quorum", resolved: true, resolution: "rejected", votes, rounds: 1,
      metadata: { approves, rejects, abstains, total, approvalRate, normalizedRejectionRate, requiredQuorum, totalParticipants, quorumMet },
    };
  }

  return {
    strategy: "quorum", resolved: false, votes, rounds: 1,
    metadata: { approves, rejects, abstains, total, approvalRate, normalizedApprovalRate, normalizedRejectionRate, requiredQuorum, totalParticipants, quorumMet, reason: quorumMet ? "threshold not met" : "quorum not met" },
  };
}

function isApprove(position: string): boolean {
  const normalized = position.toLowerCase();
  return normalized.includes("agree") || normalized.includes("approve") || normalized === "yes";
}

function isReject(position: string): boolean {
  const normalized = position.toLowerCase();
  return normalized.includes("disagree") || normalized.includes("reject") || normalized === "no";
}

function mapVoteToPosition(vote: ConsensusRoundVote["vote"]): string {
  return vote;
}

function rowToRound(row: Record<string, unknown>): ConsensusRound {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    topic: String(row.topic),
    description: row.description == null ? null : String(row.description),
    participants: Array.isArray(row.participants) ? row.participants.map(String) : [],
    requiredMajority: Number(row.requiredMajority ?? 0.667),
    status: String(row.status) as ConsensusRoundStatus,
    result: row.result == null ? null : String(row.result),
    resolvedAt: row.resolvedAt == null ? null : new Date(String(row.resolvedAt)),
    createdAt: new Date(String(row.createdAt)),
    votes: [],
  };
}

function rowToVote(row: Record<string, unknown>): ConsensusRoundVote {
  return {
    agentId: String(row.agentId),
    vote: String(row.vote) as ConsensusRoundVote["vote"],
    reasoning: row.reasoning == null ? null : String(row.reasoning),
    castAt: row.castAt instanceof Date ? row.castAt : new Date(String(row.castAt)),
  };
}

function toEngineVotes(votes: ConsensusRoundVote[]): Vote[] {
  return votes.map((vote) => ({
    agentRole: vote.agentId,
    instanceId: vote.agentId,
    position: mapVoteToPosition(vote.vote),
    confidence: vote.vote === "abstain" ? 0 : 1,
    evidence: vote.reasoning ? [vote.reasoning] : undefined,
  }));
}

async function loadConsensusRound(roundId: string): Promise<ConsensusRound | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id,
            workspace_id AS "workspaceId",
            topic,
            description,
            participants,
            required_majority AS "requiredMajority",
            status,
            result,
            resolved_at AS "resolvedAt",
            created_at AS "createdAt"
     FROM consensus_rounds
     WHERE id = $1`,
    [roundId],
  );

  if (!rows[0]) return null;
  const round = rowToRound(rows[0] as Record<string, unknown>);

  const { rows: voteRows } = await pool.query(
    `SELECT agent_id AS "agentId",
            vote,
            reasoning,
            cast_at AS "castAt"
     FROM consensus_votes
     WHERE round_id = $1
     ORDER BY cast_at ASC`,
    [roundId],
  );

  round.votes = voteRows.map((row) => rowToVote(row as Record<string, unknown>));
  return round;
}

export async function initiateConsensus(
  workspaceId: string,
  proposal: ConsensusProposal,
): Promise<ConsensusRound> {
  const pool = getPool();
  const id = randomUUID();
  const requiredMajority = proposal.requiredMajority ?? 0.667;

  await pool.query(
    `INSERT INTO consensus_rounds (id, workspace_id, topic, description, participants, required_majority, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
    [id, workspaceId, proposal.topic, proposal.description ?? null, proposal.participants, requiredMajority],
  );

  return {
    id,
    workspaceId,
    topic: proposal.topic,
    description: proposal.description ?? null,
    participants: [...proposal.participants],
    requiredMajority,
    status: "open",
    result: null,
    resolvedAt: null,
    createdAt: new Date(),
    votes: [],
  };
}

export async function submitVote(
  roundId: string,
  agentId: string,
  vote: ConsensusRoundVote["vote"],
  reasoning: string,
): Promise<ConsensusRoundVote> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO consensus_votes (id, round_id, agent_id, vote, reasoning)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (round_id, agent_id)
     DO UPDATE SET vote = EXCLUDED.vote, reasoning = EXCLUDED.reasoning, cast_at = now()
     RETURNING agent_id AS "agentId", vote, reasoning, cast_at AS "castAt"`,
    [randomUUID(), roundId, agentId, vote, reasoning],
  );

  return rowToVote(rows[0] as Record<string, unknown>);
}

export async function getConsensusRounds(workspaceId: string): Promise<ConsensusRound[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id,
            workspace_id AS "workspaceId",
            topic,
            description,
            participants,
            required_majority AS "requiredMajority",
            status,
            result,
            resolved_at AS "resolvedAt",
            created_at AS "createdAt"
     FROM consensus_rounds
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );

  return rows.map((row) => rowToRound(row as Record<string, unknown>)).map((round) => ({ ...round, votes: [] }));
}

export async function getConsensusRound(roundId: string): Promise<ConsensusRound | null> {
  return loadConsensusRound(roundId);
}

export async function resolveConsensus(roundId: string): Promise<ConsensusRound> {
  const pool = getPool();
  const round = await loadConsensusRound(roundId);

  if (!round) {
    throw new Error("Round not found");
  }

  const engineVotes = toEngineVotes(round.votes);
  const resolution = await runConsensus(engineVotes, {
    strategy: "quorum",
    requiredQuorum: round.requiredMajority,
    participantCount: round.participants.length,
  });

  const allVotesCast = round.participants.length > 0 && round.votes.length >= round.participants.length;
  const status: ConsensusRoundStatus = resolution.resolved
    ? "resolved"
    : allVotesCast
      ? "failed"
      : "open";
  const result = resolution.resolved ? resolution.resolution ?? null : null;
  const resolvedAt = resolution.resolved ? new Date() : null;

  if (status !== round.status || result !== round.result || resolvedAt) {
    await pool.query(
      `UPDATE consensus_rounds
       SET status = $2,
           result = $3,
           resolved_at = $4
       WHERE id = $1`,
      [roundId, status, result, resolvedAt],
    );
  }

  return {
    ...round,
    status,
    result,
    resolvedAt,
  };
}
