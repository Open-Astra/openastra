import type { AgentConfig } from "./types.js";
import type { InferenceClient, ChatMessage } from "../inference/types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("voting");

// ── Agent Voting / Consensus ─────────────────────────────────────────

export type VotingStrategy = "majority" | "unanimous" | "weighted" | "ranked";

export interface Vote {
  agentId: string;
  choice: string;
  confidence: number;
  reasoning?: string;
}

export interface VotingResult {
  winner: string;
  votes: Vote[];
  consensus: boolean;
  margin: number;
}

/**
 * Conduct a vote among multiple agents to reach consensus on a question.
 *
 * Each agent makes an inference call to choose from the options.
 * The strategy determines how votes are aggregated:
 * - majority: most votes wins
 * - unanimous: all must agree
 * - weighted: votes weighted by agent confidence scores
 * - ranked: agents rank all options, use Borda count
 */
export async function conductVote(
  question: string,
  options: string[],
  agents: Array<{ config: AgentConfig; client: InferenceClient }>,
  strategy: VotingStrategy,
): Promise<VotingResult> {
  if (agents.length === 0) {
    throw new Error("At least one agent is required for voting");
  }
  if (options.length < 2) {
    throw new Error("At least two options are required for voting");
  }

  const votes: Vote[] = [];

  if (strategy === "ranked") {
    return conductRankedVote(question, options, agents);
  }

  // Collect votes from all agents in parallel
  const votePromises = agents.map(async ({ config, client }) => {
    try {
      const vote = await collectVote(question, options, config, client);
      return vote;
    } catch (err) {
      log.warn(`Agent ${config.id} failed to vote: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  const results = await Promise.all(votePromises);
  for (const v of results) {
    if (v) votes.push(v);
  }

  if (votes.length === 0) {
    throw new Error("No agents successfully voted");
  }

  return aggregateVotes(votes, options, strategy);
}

async function collectVote(
  question: string,
  options: string[],
  config: AgentConfig,
  client: InferenceClient,
): Promise<Vote> {
  const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a voting participant. Choose exactly one option and provide your confidence (0.0 to 1.0) and brief reasoning. Respond in JSON format: {"choice": "<exact option text>", "confidence": <number>, "reasoning": "<brief reason>"}`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nOptions:\n${optionsList}\n\nChoose one option. Respond with JSON only.`,
    },
  ];

  const response = await client.chat({
    messages,
    temperature: config.model.temperature,
    maxTokens: 300,
  });

  const content = response.content ?? "";
  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    const parsed = JSON.parse(jsonMatch[0]) as { choice: string; confidence: number; reasoning?: string };

    // Validate the choice is one of the options
    const choice = options.find(
      (o) => o.toLowerCase() === String(parsed.choice).toLowerCase(),
    ) ?? options[0];

    return {
      agentId: config.id,
      choice,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
    };
  } catch {
    // Fallback: try to match any option mentioned in the response
    const lowerContent = content.toLowerCase();
    const matched = options.find((o) => lowerContent.includes(o.toLowerCase()));
    return {
      agentId: config.id,
      choice: matched ?? options[0],
      confidence: 0.3,
      reasoning: "Failed to parse structured response",
    };
  }
}

function aggregateVotes(
  votes: Vote[],
  options: string[],
  strategy: VotingStrategy,
): VotingResult {
  // Count votes per option
  const counts = new Map<string, number>();
  const weightedCounts = new Map<string, number>();
  for (const opt of options) {
    counts.set(opt, 0);
    weightedCounts.set(opt, 0);
  }

  for (const vote of votes) {
    counts.set(vote.choice, (counts.get(vote.choice) ?? 0) + 1);
    weightedCounts.set(
      vote.choice,
      (weightedCounts.get(vote.choice) ?? 0) + vote.confidence,
    );
  }

  if (strategy === "weighted") {
    // Use weighted counts
    let maxWeight = 0;
    let winner = options[0];
    let secondWeight = 0;
    for (const [opt, w] of weightedCounts) {
      if (w > maxWeight) {
        secondWeight = maxWeight;
        maxWeight = w;
        winner = opt;
      } else if (w > secondWeight) {
        secondWeight = w;
      }
    }
    const totalWeight = Array.from(weightedCounts.values()).reduce((a, b) => a + b, 0);
    const margin = totalWeight > 0 ? (maxWeight - secondWeight) / totalWeight : 0;

    return { winner, votes, consensus: margin > 0.3, margin };
  }

  if (strategy === "unanimous") {
    const uniqueChoices = new Set(votes.map((v) => v.choice));
    const isUnanimous = uniqueChoices.size === 1;
    const winner = isUnanimous ? votes[0].choice : getMajorityWinner(counts, options);
    return { winner, votes, consensus: isUnanimous, margin: isUnanimous ? 1 : 0 };
  }

  // Default: majority
  const winner = getMajorityWinner(counts, options);
  const winnerCount = counts.get(winner) ?? 0;
  const margin = votes.length > 0 ? winnerCount / votes.length : 0;
  return { winner, votes, consensus: margin > 0.5, margin };
}

function getMajorityWinner(counts: Map<string, number>, options: string[]): string {
  let maxCount = 0;
  let winner = options[0];
  for (const [opt, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      winner = opt;
    }
  }
  return winner;
}

async function conductRankedVote(
  question: string,
  options: string[],
  agents: Array<{ config: AgentConfig; client: InferenceClient }>,
): Promise<VotingResult> {
  const votes: Vote[] = [];
  const bordaScores = new Map<string, number>();
  for (const opt of options) {
    bordaScores.set(opt, 0);
  }

  const rankPromises = agents.map(async ({ config, client }) => {
    try {
      return await collectRankedVote(question, options, config, client);
    } catch (err) {
      log.warn(`Agent ${config.id} failed ranked vote: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });

  const results = await Promise.all(rankPromises);

  for (const result of results) {
    if (!result) continue;
    const { agentId, rankings, confidence, reasoning } = result;

    // Borda count: N-1 points for first, N-2 for second, etc.
    for (let i = 0; i < rankings.length; i++) {
      const points = options.length - 1 - i;
      bordaScores.set(rankings[i], (bordaScores.get(rankings[i]) ?? 0) + points);
    }

    votes.push({
      agentId,
      choice: rankings[0], // top choice
      confidence,
      reasoning,
    });
  }

  if (votes.length === 0) {
    throw new Error("No agents successfully voted");
  }

  let maxScore = 0;
  let winner = options[0];
  let secondScore = 0;
  for (const [opt, score] of bordaScores) {
    if (score > maxScore) {
      secondScore = maxScore;
      maxScore = score;
      winner = opt;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const totalScore = Array.from(bordaScores.values()).reduce((a, b) => a + b, 0);
  const margin = totalScore > 0 ? (maxScore - secondScore) / totalScore : 0;

  return { winner, votes, consensus: margin > 0.2, margin };
}

async function collectRankedVote(
  question: string,
  options: string[],
  config: AgentConfig,
  client: InferenceClient,
): Promise<{ agentId: string; rankings: string[]; confidence: number; reasoning?: string }> {
  const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a voting participant. Rank ALL options from best to worst. Respond in JSON format: {"rankings": ["<best option>", "<second best>", ...], "confidence": <0.0-1.0>, "reasoning": "<brief reason>"}`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nOptions:\n${optionsList}\n\nRank all options. Respond with JSON only.`,
    },
  ];

  const response = await client.chat({
    messages,
    temperature: config.model.temperature,
    maxTokens: 500,
  });

  const content = response.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { agentId: config.id, rankings: options, confidence: 0.3, reasoning: "Failed to parse" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { rankings: string[]; confidence: number; reasoning?: string };
    // Validate rankings include all options
    const validRankings: string[] = [];
    for (const r of (parsed.rankings ?? [])) {
      const match = options.find((o) => o.toLowerCase() === String(r).toLowerCase());
      if (match && !validRankings.includes(match)) {
        validRankings.push(match);
      }
    }
    // Add any missing options at the end
    for (const opt of options) {
      if (!validRankings.includes(opt)) {
        validRankings.push(opt);
      }
    }

    return {
      agentId: config.id,
      rankings: validRankings,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
    };
  } catch {
    return { agentId: config.id, rankings: options, confidence: 0.3, reasoning: "Failed to parse response" };
  }
}
