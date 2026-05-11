// ── Few-Shot Example Library ───────────────────────────────────────────
// Store curated prompt examples per agent, injected before inference
// after classifying the incoming task type.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("few-shot");

export interface FewShotExample {
  id: string;
  agentId: string;
  workspaceId: string;
  taskType: string;
  userMessage: string;
  assistantResponse: string;
  score: number;
  enabled: boolean;
  createdAt: Date;
}

const TASK_KEYWORDS: Record<string, string[]> = {
  summarize: ["summarize", "summary", "tldr", "brief", "shorten"],
  translate: ["translate", "translation", "in french", "in spanish", "in german"],
  code: ["code", "function", "implement", "debug", "fix", "write a", "refactor"],
  analyze: ["analyze", "analysis", "compare", "evaluate", "assess", "review"],
  search: ["find", "search", "lookup", "look up", "retrieve", "get"],
  plan: ["plan", "steps", "how to", "strategy", "roadmap", "schedule"],
};

export function classifyTaskType(message: string): string {
  const lower = message.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return "general";
}

export async function addExample(
  agentId: string,
  workspaceId: string,
  taskType: string,
  userMessage: string,
  assistantResponse: string,
  score = 1.0,
  createdBy?: string,
): Promise<FewShotExample> {
  const id = randomUUID();
  const { rows } = await getPool().query<FewShotExample>(
    `INSERT INTO few_shot_examples
       (id, workspace_id, agent_id, task_type, user_message, assistant_response, score, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, agent_id AS "agentId", workspace_id AS "workspaceId",
               task_type AS "taskType", user_message AS "userMessage",
               assistant_response AS "assistantResponse", score, enabled, created_at AS "createdAt"`,
    [id, workspaceId, agentId, taskType, userMessage, assistantResponse, score, createdBy ?? null],
  );
  return rows[0]!;
}

export async function getExamples(
  agentId: string,
  workspaceId: string,
  taskType?: string,
  limit = 5,
): Promise<FewShotExample[]> {
  if (taskType) {
    const { rows } = await getPool().query<FewShotExample>(
      `SELECT id, agent_id AS "agentId", workspace_id AS "workspaceId",
              task_type AS "taskType", user_message AS "userMessage",
              assistant_response AS "assistantResponse", score, enabled, created_at AS "createdAt"
       FROM few_shot_examples
       WHERE agent_id = $1 AND workspace_id = $2 AND task_type = $3 AND enabled = true
       ORDER BY score DESC LIMIT $4`,
      [agentId, workspaceId, taskType, limit],
    );
    return rows;
  }
  const { rows } = await getPool().query<FewShotExample>(
    `SELECT id, agent_id AS "agentId", workspace_id AS "workspaceId",
            task_type AS "taskType", user_message AS "userMessage",
            assistant_response AS "assistantResponse", score, enabled, created_at AS "createdAt"
     FROM few_shot_examples
     WHERE agent_id = $1 AND workspace_id = $2 AND enabled = true
     ORDER BY score DESC LIMIT $3`,
    [agentId, workspaceId, limit],
  );
  return rows;
}

export async function deleteExample(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM few_shot_examples WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Build the few-shot prefix block for injection into the system prompt. */
export function buildFewShotPrefix(examples: FewShotExample[]): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((ex) =>
    `<example type="${ex.taskType}">\nUser: ${ex.userMessage}\nAssistant: ${ex.assistantResponse}\n</example>`,
  );
  return `## Examples\n\n${blocks.join("\n\n")}\n\n`;
}

/** Classify task type and fetch matching examples, falling back to general. */
export async function injectFewShot(
  agentId: string,
  workspaceId: string,
  userMessage: string,
  limit = 3,
): Promise<string> {
  const taskType = classifyTaskType(userMessage);
  let examples = await getExamples(agentId, workspaceId, taskType, limit);
  if (examples.length === 0) {
    examples = await getExamples(agentId, workspaceId, "general", limit);
  }
  logger.info(`Few-shot: ${examples.length} examples for task type "${taskType}"`);
  return buildFewShotPrefix(examples);
}
