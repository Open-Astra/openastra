import type { MessageDoc } from "./types.js";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "../agents/types.js";
import { persistMessage } from "./store.js";
import { getPool } from "../config/postgres.js";
import { indexSessionSummary } from "../memory/indexer.js";

function estimateTokensSingle(text: string): number {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return Math.ceil(text.length / 3);
  if (text.includes("```")) return Math.ceil(text.length / 6);
  return Math.ceil(text.length / 4);
}

function estimateTokens(messages: MessageDoc[]): number {
  return messages.reduce(
    (sum, m) => sum + estimateTokensSingle(m.content),
    0,
  );
}

// ── Should Compact? ─────────────────────────────────────────────────
// Returns true when session messages are approaching the context limit.
// Triggers at 70% of budget to leave room for the compaction prompt itself.

export function shouldCompact(
  messages: MessageDoc[],
  agentConfig: AgentConfig,
): boolean {
  const budget = agentConfig.model.maxContextTokens;
  const threshold = budget * 0.7;
  return estimateTokens(messages) > threshold;
}

// ── Pre-Compaction Memory Flush ─────────────────────────────────────
// Before compacting, ask the agent to write any durable memories.
// This ensures important context is persisted before older messages
// are summarized away.

const FLUSH_PROMPT =
  "The conversation is getting long and needs to be compacted. Before that happens, " +
  "review our conversation and use memory_write to save any important information that " +
  "should be remembered: decisions made, strategies discussed, user preferences " +
  "learned, or any other notable context. Write each piece as a separate memory_write call.";

export async function preCompactionFlush(
  uid: string,
  sessionId: string,
  messages: MessageDoc[],
  agentConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<void> {
  // Import dynamically to avoid circular dependency with the agent loop
  const { assembleContext } = await import("../context/assembler.js");
  const { getToolSchemas, executeTool } = await import("../tools/index.js");
  const { resolveToolPolicy } = await import("../tools/types.js");

  // Only give the agent memory_write during flush
  const flushPolicy = resolveToolPolicy([], ["memory_write"], []);
  const toolSchemas = getToolSchemas(flushPolicy.allow);

  // Add the flush instruction as a system message
  const flushMessages: MessageDoc[] = [
    ...messages,
    {
      id: "flush-prompt",
      role: "system",
      content: FLUSH_PROMPT,
      tokenEstimate: estimateTokensSingle(FLUSH_PROMPT),
      timestamp: Date.now(),
    },
  ];

  const { messages: contextMessages } = await assembleContext(
    uid,
    agentConfig,
    flushMessages,
    toolSchemas,
  );

  // Run one inference pass for the flush
  const response = await inferenceClient.chat({
    messages: contextMessages,
    tools: toolSchemas,
    temperature: 0.3, // low temp for accurate memory extraction
    maxTokens: 2048,
  });

  // Execute any memory_write tool calls the agent made
  if (response.toolCalls.length > 0) {
    const toolCtx = { uid, agentId: agentConfig.id, sessionId };
    for (const tc of response.toolCalls) {
      await executeTool(
        { id: tc.id, name: tc.name, arguments: tc.arguments },
        toolCtx,
        flushPolicy.allow,
      );
    }
  }
}

// ── Compact Session ─────────────────────────────────────────────────
// Summarizes older messages and replaces them with a single compaction
// message. Keeps the most recent messages intact.

const KEEP_RECENT = 10; // preserve the last N messages verbatim

const SUMMARIZE_PROMPT =
  "Summarize the following conversation concisely, capturing: key topics discussed, " +
  "decisions made, strategies explored, and any important " +
  "context the user shared. Keep it factual and under 500 words.";

export async function compactSession(
  uid: string,
  sessionId: string,
  messages: MessageDoc[],
  _agentConfig: AgentConfig,
  inferenceClient: InferenceClient,
): Promise<MessageDoc[]> {
  if (messages.length <= KEEP_RECENT) return messages;

  // Split: older messages to summarize, recent messages to keep
  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const toKeep = messages.slice(-KEEP_RECENT);

  // Build a conversation transcript for summarization
  const transcript = toSummarize
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const response = await inferenceClient.chat({
    messages: [
      { role: "system", content: SUMMARIZE_PROMPT },
      { role: "user", content: transcript },
    ],
    temperature: 0.3,
    maxTokens: 1024,
  });

  const summary = response.content ?? "Previous conversation context.";

  // Delete old messages from Postgres
  const pool = getPool();
  const idsToDelete = toSummarize.map((m) => m.id);

  // Archive messages before deleting
  await pool.query(
    `INSERT INTO message_archive (id, session_id, user_id, role, content, tool_calls, tool_call_id, token_estimate, timestamp, archived_at)
     SELECT m.id, m.session_id, s.user_id, m.role, m.content, m.tool_calls, m.tool_call_id, m.token_estimate, m.timestamp, NOW()
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     WHERE m.session_id = $1 AND m.id = ANY($2::uuid[])`,
    [sessionId, idsToDelete],
  );

  await pool.query(
    "DELETE FROM messages WHERE session_id = $1 AND id = ANY($2::uuid[])",
    [sessionId, idsToDelete],
  );

  // Persist the compaction summary as a system message
  const compactionMsg = await persistMessage(uid, sessionId, {
    role: "system",
    content: `[Conversation summary]\n${summary}`,
    tokenEstimate: estimateTokensSingle(summary),
    timestamp: Date.now(),
  });

  // Update session with compaction summary
  await pool.query(
    "UPDATE sessions SET compaction_summary = $1 WHERE id = $2",
    [summary, sessionId],
  );

  // Index the summary into Typesense for future retrieval
  indexSessionSummary(uid, sessionId, summary, Date.now()).catch((err) =>
    console.error("[compaction] Typesense indexing failed:", err),
  );

  return [compactionMsg, ...toKeep];
}
