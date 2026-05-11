import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "./types.js";
import { writeToBlackboard, resolveConflict, escalateConflict } from "./blackboard.js";
import { logAgentAction } from "./audit.js";
import { getPool } from "../config/postgres.js";

// ── Structured Debate Protocol ──────────────────────────────────────
// When agents in a swarm produce conflicting outputs, the debate
// protocol runs structured argumentation rounds until consensus
// or escalation. The mediator agent evaluates each position,
// requests clarification, and produces a binding verdict.
//
// Protocol phases:
//   1. Position Statement: each conflicting agent restates its position
//   2. Cross-Examination: agents challenge each other's evidence
//   3. Rebuttal: agents respond to challenges
//   4. Mediator Verdict: neutral mediator evaluates and decides
//   5. If no consensus: escalate to user (HITL)

// ── Types ───────────────────────────────────────────────────────────

export interface DebateConfig {
  maxRounds: number;            // max debate rounds before escalation (default: 3)
  consensusThreshold: number;   // confidence needed to resolve (0-1, default: 0.7)
  allowUserEscalation: boolean; // whether to escalate to user if no consensus
  timeoutMs: number;            // per-round timeout
}

export interface DebateParticipant {
  agentRole: string;
  instanceId: string;
  originalPosition: string;     // initial content from blackboard
}

export interface DebateRound {
  roundNumber: number;
  phase: "position" | "cross_examination" | "rebuttal" | "verdict";
  arguments: DebateArgument[];
  mediatorAssessment?: MediatorAssessment;
  timestamp: number;
}

export interface DebateArgument {
  agentRole: string;
  phase: DebateRound["phase"];
  content: string;
  confidence: number;           // self-assessed confidence 0-1
  evidence: string[];           // cited evidence
}

export interface MediatorAssessment {
  winner?: string;              // agentRole of the winner, if any
  confidence: number;           // mediator's confidence in the verdict
  reasoning: string;
  verdict: string;              // the resolved content
  consensusReached: boolean;
}

export interface DebateResult {
  debateId: string;
  conflictId: string;
  rounds: DebateRound[];
  resolution?: string;          // final resolved content
  resolvedBy: "consensus" | "mediator" | "user" | "timeout";
  winner?: string;
  totalRounds: number;
  durationMs: number;
}

const DEFAULT_DEBATE_CONFIG: DebateConfig = {
  maxRounds: 3,
  consensusThreshold: 0.7,
  allowUserEscalation: true,
  timeoutMs: 60_000,
};

// ── Run Debate ──────────────────────────────────────────────────────

export async function runDebate(
  uid: string,
  swarmId: string,
  conflictId: string,
  section: string,
  participants: DebateParticipant[],
  baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  config: Partial<DebateConfig> = {},
): Promise<DebateResult> {
  const opts = { ...DEFAULT_DEBATE_CONFIG, ...config };
  const debateId = randomUUID();
  const start = Date.now();

  console.log(`[debate] Starting debate ${debateId.slice(0, 8)} — ${participants.length} participants, section="${section}"`);

  const rounds: DebateRound[] = [];
  let resolution: string | undefined;
  let resolvedBy: DebateResult["resolvedBy"] = "timeout";
  let winner: string | undefined;

  for (let roundNum = 1; roundNum <= opts.maxRounds; roundNum++) {
    // Phase 1: Position statements (each agent restates with evidence)
    const positionArgs = await gatherPositions(
      uid, swarmId, participants, baseConfig, inferenceClient, roundNum,
    );

    // Phase 2: Cross-examination (each agent challenges others)
    const crossExamArgs = await crossExamine(
      uid, swarmId, participants, positionArgs, baseConfig, inferenceClient,
    );

    // Phase 3: Rebuttal (each agent responds to challenges)
    const rebuttalArgs = await gatherRebuttals(
      uid, swarmId, participants, crossExamArgs, baseConfig, inferenceClient,
    );

    // Phase 4: Mediator verdict
    const allArgs = [...positionArgs, ...crossExamArgs, ...rebuttalArgs];
    const assessment = await mediatorVerdict(
      uid, swarmId, section, allArgs, baseConfig, inferenceClient,
    );

    const round: DebateRound = {
      roundNumber: roundNum,
      phase: "verdict",
      arguments: allArgs,
      mediatorAssessment: assessment,
      timestamp: Date.now(),
    };
    rounds.push(round);

    // Check for consensus
    if (assessment.consensusReached && assessment.confidence >= opts.consensusThreshold) {
      resolution = assessment.verdict;
      resolvedBy = assessment.winner ? "mediator" : "consensus";
      winner = assessment.winner;

      // Write resolution to blackboard and resolve conflict
      await writeToBlackboard(uid, swarmId, "mediator", "debate-resolution", section, resolution);
      await resolveConflict(uid, swarmId, conflictId, resolution, "debate");

      console.log(`[debate] Resolved after ${roundNum} round(s) — ${resolvedBy}`);
      break;
    }

    // If last round and no consensus, escalate
    if (roundNum === opts.maxRounds) {
      if (opts.allowUserEscalation) {
        await escalateConflict(uid, swarmId, conflictId);
        resolvedBy = "user";
        console.log(`[debate] Escalated to user after ${roundNum} rounds`);
      } else {
        // Force mediator decision
        resolution = assessment.verdict;
        resolvedBy = "mediator";
        winner = assessment.winner;
        await resolveConflict(uid, swarmId, conflictId, resolution, "debate-forced");
      }
    }
  }

  const result: DebateResult = {
    debateId,
    conflictId,
    rounds,
    resolution,
    resolvedBy,
    winner,
    totalRounds: rounds.length,
    durationMs: Date.now() - start,
  };

  // Persist debate
  await persistDebate(uid, swarmId, result);

  await logAgentAction(uid, baseConfig.id, "debate_complete" as any, {
    debateId,
    conflictId,
    resolvedBy,
    rounds: rounds.length,
    durationMs: result.durationMs,
  }, result.durationMs);

  return result;
}

// ── Debate Phases ───────────────────────────────────────────────────

async function gatherPositions(
  _uid: string,
  _swarmId: string,
  participants: DebateParticipant[],
  _baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
  roundNumber: number,
): Promise<DebateArgument[]> {
  const args: DebateArgument[] = [];

  for (const p of participants) {
    const response = await inferenceClient.chat({
      messages: [
        {
          role: "system",
          content: `You are a ${p.agentRole} in a structured debate (round ${roundNumber}).
Restate your position clearly with evidence.
Respond in JSON: { "position": "...", "confidence": 0.0-1.0, "evidence": ["..."] }`,
        },
        {
          role: "user",
          content: `Your original finding: ${p.originalPosition}\n\nRestate your position with supporting evidence.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 800,
    });

    const parsed = safeParseDebateResponse(response.content ?? "");
    args.push({
      agentRole: p.agentRole,
      phase: "position",
      content: parsed.position,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
    });
  }

  return args;
}

async function crossExamine(
  _uid: string,
  _swarmId: string,
  participants: DebateParticipant[],
  positions: DebateArgument[],
  _baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<DebateArgument[]> {
  const args: DebateArgument[] = [];

  for (const p of participants) {
    const othersPositions = positions
      .filter((a) => a.agentRole !== p.agentRole)
      .map((a) => `${a.agentRole}: ${a.content}`)
      .join("\n");

    const response = await inferenceClient.chat({
      messages: [
        {
          role: "system",
          content: `You are a ${p.agentRole}. Challenge the other agents' positions.
Identify weaknesses, missing evidence, or logical flaws.
Respond in JSON: { "challenges": "...", "confidence": 0.0-1.0, "evidence": ["..."] }`,
        },
        {
          role: "user",
          content: `Other positions:\n${othersPositions}\n\nChallenge their arguments.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 600,
    });

    const parsed = safeParseDebateResponse(response.content ?? "");
    args.push({
      agentRole: p.agentRole,
      phase: "cross_examination",
      content: parsed.position || parsed.challenges,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
    });
  }

  return args;
}

async function gatherRebuttals(
  _uid: string,
  _swarmId: string,
  participants: DebateParticipant[],
  challenges: DebateArgument[],
  _baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<DebateArgument[]> {
  const args: DebateArgument[] = [];

  for (const p of participants) {
    const challengesToMe = challenges
      .filter((a) => a.agentRole !== p.agentRole)
      .map((a) => `${a.agentRole}: ${a.content}`)
      .join("\n");

    const response = await inferenceClient.chat({
      messages: [
        {
          role: "system",
          content: `You are a ${p.agentRole}. Respond to the challenges against your position.
Address each concern and provide additional evidence if available.
Respond in JSON: { "rebuttal": "...", "confidence": 0.0-1.0, "evidence": ["..."] }`,
        },
        {
          role: "user",
          content: `Challenges to your position:\n${challengesToMe}\n\nProvide your rebuttal.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 600,
    });

    const parsed = safeParseDebateResponse(response.content ?? "");
    args.push({
      agentRole: p.agentRole,
      phase: "rebuttal",
      content: parsed.position || parsed.rebuttal,
      confidence: parsed.confidence,
      evidence: parsed.evidence,
    });
  }

  return args;
}

async function mediatorVerdict(
  _uid: string,
  _swarmId: string,
  section: string,
  allArguments: DebateArgument[],
  _baseConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<MediatorAssessment> {
  const debateTranscript = allArguments
    .map((a) => `[${a.phase}] ${a.agentRole} (confidence: ${a.confidence}): ${a.content}`)
    .join("\n\n");

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are a neutral mediator resolving a debate between agents about "${section}".
Evaluate each position objectively, consider the evidence, and produce a verdict.

Respond in JSON:
{
  "winner": "<agentRole>" or null,
  "confidence": 0.0-1.0,
  "reasoning": "Why this decision was made...",
  "verdict": "The resolved content / synthesis of best arguments...",
  "consensusReached": true/false
}`,
      },
      {
        role: "user",
        content: `Debate transcript:\n${debateTranscript}\n\nProvide your verdict.`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1000,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in mediator response");

    const parsed = JSON.parse(jsonMatch[0]) as Partial<MediatorAssessment>;
    return {
      winner: parsed.winner ?? undefined,
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      reasoning: parsed.reasoning ?? "Insufficient information for definitive verdict.",
      verdict: parsed.verdict ?? "Unable to resolve — escalating to user.",
      consensusReached: parsed.consensusReached ?? false,
    };
  } catch {
    return {
      confidence: 0.3,
      reasoning: "Mediator failed to produce a structured verdict.",
      verdict: "Unable to resolve — escalating to user.",
      consensusReached: false,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeParseDebateResponse(content: string): {
  position: string;
  challenges: string;
  rebuttal: string;
  confidence: number;
  evidence: string[];
} {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { position: content, challenges: "", rebuttal: "", confidence: 0.5, evidence: [] };

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      position: String(parsed.position ?? ""),
      challenges: String(parsed.challenges ?? ""),
      rebuttal: String(parsed.rebuttal ?? ""),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    };
  } catch {
    return { position: content, challenges: "", rebuttal: "", confidence: 0.5, evidence: [] };
  }
}

async function persistDebate(uid: string, swarmId: string, result: DebateResult): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO debate_records (id, swarm_id, conflict_id, user_id, config, status, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET config = $5::jsonb, status = $6`,
    [result.debateId, swarmId, result.conflictId, uid, JSON.stringify(result), result.resolvedBy],
  );
}

// ── Structured Two-Agent Debate (Feature 1) ──────────────────────────
// Simpler three-turn debate: Agent A opens, Agent B responds, judge synthesizes.
// Used by the /debates REST endpoint — persists to debate_sessions table.

export interface StructuredDebateResult {
  sessionId: string;
  topic: string;
  rounds: Array<{ speaker: "agent_a" | "agent_b" | "judge"; agentId: string; content: string }>;
  synthesis: string;
  winnerRationale: string;
}

export async function runStructuredDebate(
  topic: string,
  agentAConfig: AgentConfig,
  agentBConfig: AgentConfig,
  judgeConfig: AgentConfig,
  clientA: InferenceClient,
  clientB: InferenceClient,
  clientJudge: InferenceClient,
  workspaceId: string,
): Promise<StructuredDebateResult> {
  const { getEventBus } = await import("../events/index.js");
  const pool = getPool();
  const bus = getEventBus();

  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO debate_sessions (workspace_id, topic, agent_a_id, agent_b_id, judge_agent_id, status)
     VALUES ($1, $2, $3, $4, $5, 'running')
     RETURNING id`,
    [workspaceId, topic, agentAConfig.id, agentBConfig.id, judgeConfig.id],
  );
  const sessionId = insertResult.rows[0].id;

  const rounds: StructuredDebateResult["rounds"] = [];

  // Agent A opens
  const responseA = await clientA.chat({
    messages: [
      { role: "system", content: agentAConfig.systemPromptTemplate },
      {
        role: "user",
        content: `You are participating in a structured debate. Topic: "${topic}". Present your opening position clearly.`,
      },
    ],
    temperature: agentAConfig.model.temperature,
    maxTokens: agentAConfig.model.maxOutputTokens,
    sessionId: randomUUID(),
  });
  const positionA = responseA.content ?? "";
  rounds.push({ speaker: "agent_a", agentId: agentAConfig.id, content: positionA });

  // Agent B responds
  const responseB = await clientB.chat({
    messages: [
      { role: "system", content: agentBConfig.systemPromptTemplate },
      {
        role: "user",
        content: `You are participating in a structured debate. Topic: "${topic}".\n\nOpposing position:\n${positionA}\n\nPresent your counter-position.`,
      },
    ],
    temperature: agentBConfig.model.temperature,
    maxTokens: agentBConfig.model.maxOutputTokens,
    sessionId: randomUUID(),
  });
  const positionB = responseB.content ?? "";
  rounds.push({ speaker: "agent_b", agentId: agentBConfig.id, content: positionB });

  // Judge synthesizes
  const responseJudge = await clientJudge.chat({
    messages: [
      { role: "system", content: judgeConfig.systemPromptTemplate },
      {
        role: "user",
        content: `You are judging a debate on: "${topic}".\n\nAgent A:\n${positionA}\n\nAgent B:\n${positionB}\n\nSynthesize both positions and provide your verdict. End with a "Winner rationale:" section.`,
      },
    ],
    temperature: judgeConfig.model.temperature,
    maxTokens: judgeConfig.model.maxOutputTokens,
    sessionId: randomUUID(),
  });
  const judgeContent = responseJudge.content ?? "";
  rounds.push({ speaker: "judge", agentId: judgeConfig.id, content: judgeContent });

  const rationaleMatch = judgeContent.match(/winner\s+rationale:\s*([\s\S]+)/i);
  const winnerRationale = rationaleMatch ? rationaleMatch[1].trim() : judgeContent;

  await pool.query(
    `UPDATE debate_sessions SET status = 'completed', synthesis = $1 WHERE id = $2`,
    [judgeContent, sessionId],
  );

  bus.emit("debate.completed" as any, {
    sessionId,
    workspaceId,
    topic,
    agentAId: agentAConfig.id,
    agentBId: agentBConfig.id,
    judgeAgentId: judgeConfig.id,
    synthesis: judgeContent,
    timestamp: Date.now(),
  });

  return { sessionId, topic, rounds, synthesis: judgeContent, winnerRationale };
}
