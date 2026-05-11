// ── Dynamic Team Formation ──────────────────────────────────────────
// Automatically assemble optimal agent teams for complex tasks using
// skill matching via embeddings and reputation scores.

import { randomUUID } from "node:crypto";
import { getAllAgentConfigs } from "../config/agents.js";
import { generateEmbedding } from "../memory/embeddings.js";
import { getReputation } from "./reputation.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("team-formation");

// ── Types ────────────────────────────────────────────────────────────

export interface TeamCandidate {
  agentId: string;
  agentName: string;
  matchScore: number;
  reputationScore: number;
  compositeScore: number;
  role: string;
}

export interface FormedTeam {
  id: string;
  task: string;
  members: TeamCandidate[];
  leadAgentId: string;
  estimatedCapability: number;
  createdAt: number;
}

// ── In-memory store ──────────────────────────────────────────────────

const formedTeams = new Map<string, FormedTeam>();
// Index by workspace for listing
const workspaceTeams = new Map<string, Set<string>>();

// ── Helpers ──────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function assignRole(
  index: number,
  skills: string[],
): string {
  if (index === 0) return "lead";
  const hasReviewSkill = skills.some(
    (s) => s.toLowerCase().includes("review") || s.toLowerCase().includes("audit"),
  );
  if (hasReviewSkill) return "reviewer";
  return "specialist";
}

// ── Core ─────────────────────────────────────────────────────────────

export async function formTeam(
  workspaceId: string,
  task: string,
  opts?: {
    maxMembers?: number;
    requiredSkills?: string[];
    preferredAgents?: string[];
  },
): Promise<FormedTeam> {
  const maxMembers = Math.min(opts?.maxMembers ?? 3, 8);
  const allConfigs = getAllAgentConfigs();

  if (allConfigs.size === 0) {
    const team: FormedTeam = {
      id: randomUUID(),
      task,
      members: [],
      leadAgentId: "",
      estimatedCapability: 0,
      createdAt: Date.now(),
    };
    storeTeam(workspaceId, team);
    return team;
  }

  // Generate embedding for the task
  let taskEmbedding: number[];
  try {
    taskEmbedding = await generateEmbedding(task);
  } catch (err) {
    log.error("Failed to generate task embedding:", err);
    taskEmbedding = [];
  }

  // Score each agent
  const candidates: TeamCandidate[] = [];

  for (const [agentId, config] of allConfigs) {
    // Build agent description text for embedding
    const agentText = [
      config.displayName,
      config.systemPromptTemplate.slice(0, 200),
      ...(config.skills ?? []),
    ].join(" ");

    // Compute skill match score
    let matchScore = 0;
    if (taskEmbedding.length > 0) {
      try {
        const agentEmbedding = await generateEmbedding(agentText);
        matchScore = cosineSimilarity(taskEmbedding, agentEmbedding);
      } catch {
        matchScore = 0;
      }
    }

    // Boost preferred agents
    if (opts?.preferredAgents?.includes(agentId)) {
      matchScore = Math.min(1, matchScore + 0.2);
    }

    // Boost agents with required skills
    if (opts?.requiredSkills?.length) {
      const agentSkills = config.skills ?? [];
      const matched = opts.requiredSkills.filter((s) => agentSkills.includes(s));
      if (matched.length > 0) {
        matchScore = Math.min(1, matchScore + 0.1 * matched.length);
      }
    }

    // Get reputation score
    let reputationScore = 0.5;
    try {
      const rep = await getReputation(workspaceId, agentId);
      if (rep.totalInteractions > 0) {
        reputationScore = rep.overallScore;
      }
    } catch {
      // Default to 0.5 if reputation unavailable
    }

    const compositeScore = 0.6 * matchScore + 0.4 * reputationScore;

    candidates.push({
      agentId,
      agentName: config.displayName,
      matchScore,
      reputationScore,
      compositeScore,
      role: "", // assigned after sorting
    });
  }

  // Sort by composite score descending and take top N
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  const selected = candidates.slice(0, maxMembers);

  // Assign roles
  for (let i = 0; i < selected.length; i++) {
    const agentConfig = allConfigs.get(selected[i]!.agentId);
    const skills = agentConfig?.skills ?? [];
    selected[i]!.role = assignRole(i, skills);
  }

  const leadAgentId = selected[0]?.agentId ?? "";
  const estimatedCapability =
    selected.length > 0
      ? selected.reduce((sum, m) => sum + m.compositeScore, 0) / selected.length
      : 0;

  const team: FormedTeam = {
    id: randomUUID(),
    task,
    members: selected,
    leadAgentId,
    estimatedCapability,
    createdAt: Date.now(),
  };

  storeTeam(workspaceId, team);
  return team;
}

function storeTeam(workspaceId: string, team: FormedTeam): void {
  formedTeams.set(team.id, team);
  let wsSet = workspaceTeams.get(workspaceId);
  if (!wsSet) {
    wsSet = new Set();
    workspaceTeams.set(workspaceId, wsSet);
  }
  wsSet.add(team.id);
}

export function getFormedTeams(workspaceId: string): FormedTeam[] {
  const teamIds = workspaceTeams.get(workspaceId);
  if (!teamIds) return [];
  const teams: FormedTeam[] = [];
  for (const id of teamIds) {
    const team = formedTeams.get(id);
    if (team) teams.push(team);
  }
  return teams.sort((a, b) => b.createdAt - a.createdAt);
}

export function getFormedTeam(teamId: string): FormedTeam | null {
  return formedTeams.get(teamId) ?? null;
}
