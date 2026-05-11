import { getPool } from "../config/postgres.js";
import type { AgentConfig } from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("budget-forecast");

export interface TokenForecast {
  estimated: number;
  budget: number;
  willExceed: boolean;
  breakdown: {
    historyTokens: number;
    toolSchemaTokens: number;
    messageTokens: number;
    memoryTokens: number;
  };
}

export async function forecastTokenUsage(
  _uid: string,
  agentConfig: AgentConfig,
  messageText: string,
  sessionId: string,
): Promise<TokenForecast> {
  const pool = getPool();

  // Estimate history tokens from recent messages in the session
  const historyResult = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(token_estimate), 0) as total
     FROM (
       SELECT token_estimate FROM messages
       WHERE session_id = $1
       ORDER BY timestamp DESC
       LIMIT $2
     ) sub`,
    [sessionId, agentConfig.session.maxContextMessages],
  );
  const historyTokens = Number(historyResult.rows[0]?.total ?? 0);

  // Estimate message tokens (rough: 1 token per 4 chars)
  const messageTokens = Math.ceil(messageText.length / 4);

  // Estimate memory tokens (typical memory context ~500 tokens)
  const memoryTokens = 500;

  // Estimate tool schema tokens (~80 tokens per tool schema on average)
  const toolSchemaTokens = agentConfig.tools.allow.length * 80;

  const estimated = historyTokens + messageTokens + memoryTokens + toolSchemaTokens;
  const budget = agentConfig.model.maxContextTokens;

  log.dim(`Budget forecast for agent=${agentConfig.id}: estimated=${estimated}/${budget}`);

  return {
    estimated,
    budget,
    willExceed: estimated > budget,
    breakdown: { historyTokens, toolSchemaTokens, messageTokens, memoryTokens },
  };
}
