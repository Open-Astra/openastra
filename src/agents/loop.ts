import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import type { SessionKey, MessageDoc } from "../sessions/types.js";
import type { InferenceClient } from "../inference/types.js";
import type { ToolResult } from "../tools/types.js";
import { extractConfidenceSignals } from "./confidence.js";
import { detectPersonaContext } from "./persona.js";
import { loadActiveGoals, buildGoalContext } from "./goals.js";
import { resolveSession, persistMessage } from "../sessions/store.js";
import { shouldCompact, preCompactionFlush, compactSession } from "../sessions/compaction.js";
import { assembleContext, trimToolSchemas } from "../context/assembler.js";
import { getToolSchemas, executeTool } from "../tools/index.js";
import { redactToolResults } from "../tools/result-redactor.js";
import { resolveToolPolicy } from "../tools/types.js";
import { getEventBus } from "../events/index.js";
import { emitAgentStarted, emitToolCallStart, emitToolCallEnd, emitAgentCompleted } from "./lifecycle.js";
import { fireWebhooksForEvent } from "../webhooks/dispatcher.js";
import { getSkillToolNames } from "../skills/registry.js";
import { postTurnAutoSave } from "./post-turn-save.js";
import { graphSearch } from "../memory/graph.js";
import { reinforceEntity } from "../memory/auto-extract.js";
import { getPool } from "../config/postgres.js";
import { shouldReflect, reflectOnResponse } from "./reflection.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { AgentTracer } from "./tracer.js";
import { getAgentProfile } from "../memory/profiles.js";
import { writeInferencePayload } from "../inference/payload-audit.js";
import { getSemanticCache, setSemanticCache } from "../cache/semantic.js";
import { getMood, updateMood, getMoodSystemSuffix } from "./mood.js";
import { buildSessionContext, saveSessionSummary } from "../memory/context-bridge.js";
import { classifyTone, detectToneDrift } from "./tone-drift.js";
import type { MessageInput } from "./message-input.js";
import { normalizeMessageInput, toContentParts } from "./message-input.js";
import { updatePresence } from "./presence.js";
import { detectHandoffSignal } from "./handoff.js";
import { detectPersonaSwapCommand, applyPersonaSwap } from "./persona-swap.js";
import { checkQuota, recordTokenUsage } from "./quotas.js";
import { checkDataResidency } from "../security/data-residency.js";
import { incrementActiveSessions, decrementActiveSessions } from "./load-balancer.js";
import { getSwarmCache, setSwarmCache } from "../memory/swarm-l1.js";
import { getTurnCache, setTurnCache } from "../cache/turn-hash-cache.js";
import { refineMemoriesForSession } from "./memory-refiner.js";
import { runSelfCritique } from "./self-critique.js";
import { evaluateSkillConditions } from "../skills/skill-guards.js";
import { autoDiscoverComposition } from "../tools/tool-composer.js";
import { buildToolDependencyGraph } from "../tools/dependency-graph.js";
import { createLogger } from "../utils/logger.js";

// ── Agent Loop Configuration ────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10; // prevent infinite tool loops
const logger = createLogger("agent-loop");

// ── Session-Scoped Webhook ───────────────────────────────────────────
// Fire-and-forget POST to a URL registered at session creation.
// Failures are silently swallowed — the agent loop must not block on this.

async function fireSessionWebhook(webhookUrl: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!webhookUrl) return;
  if (await isBlockedUrl(webhookUrl)) return;
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Astra-Session-Webhook/1.0" },
    body: JSON.stringify({ event: "agent.turn.completed", ...payload }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ── Agent Turn Result ───────────────────────────────────────────────

export interface AgentResponse {
  content: string;
  toolResults: ToolResult[];
  sessionId: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
    cached: number;
  };
}

// ── Partition Tool Calls ────────────────────────────────────────────
// Splits tool calls into reads (parallel-safe) and writes (sequential).

const SEQUENTIAL_TOOLS = new Set([
  "memory_write", "knowledge_ingest", "knowledge_delete",
  "file_write", "shell_execute", "push_notify",
  "send_email", "send_webhook", "agent_spawn",
  "auto_extract_facts", "auto_save_summary",
  "run_workflow", "run_procedure", "find_and_run_procedure",
]);

function partitionToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): { reads: Array<{ id: string; name: string; arguments: string }>; writes: Array<{ id: string; name: string; arguments: string }> } {
  const reads: Array<{ id: string; name: string; arguments: string }> = [];
  const writes: Array<{ id: string; name: string; arguments: string }> = [];
  for (const tc of calls) {
    if (SEQUENTIAL_TOOLS.has(tc.name)) {
      writes.push(tc);
    } else {
      reads.push(tc);
    }
  }
  return { reads, writes };
}

// ── Run Agent Loop ──────────────────────────────────────────────────
// This is the core execution cycle:
//
//   1. Resolve session (find or create)
//   2. Persist user message
//   3. Assemble context (system prompt + memory + history)
//   4. Call inference
//   5. If tool calls → partition into reads/writes → execute (reads parallel, writes sequential) → feed results back → goto 4
//   6. Optional reflection pass on final response
//   7. Persist assistant response
//   8. Post-turn auto-save (fire-and-forget)
//   9. Return final response

export async function runAgentLoop(
  uid: string,
  userMessageInput: string | MessageInput,
  agentConfig: AgentConfig,
  inferenceClient: InferenceClient,
  sessionKey?: SessionKey,
  workspaceId?: string,
  webhookUrl?: string,
): Promise<AgentResponse> {
  const userMessage = typeof userMessageInput === "string"
    ? userMessageInput
    : normalizeMessageInput(userMessageInput);

  // Extract multimodal content parts for vision-capable agents
  const isVisionCapable = agentConfig.model.capabilities?.includes("vision") ?? false;
  const multimodalParts = isVisionCapable && typeof userMessageInput !== "string"
    ? toContentParts(userMessageInput)
    : null;

  // Default session key: main chat
  const key: SessionKey = sessionKey ?? {
    uid,
    surface: "chat",
    surfaceId: "main",
  };

  // Extract swarmId if this loop was invoked from a swarm agent.
  // Swarm sessions use surfaceId format: swarm-<swarmId>-<instanceId>
  const swarmMatch = /^swarm-([a-f0-9-]{36})-/.exec(key.surfaceId);
  const swarmId: string | null = swarmMatch ? swarmMatch[1]! : null;

  // Persona swap detection: check for !persona command
  const personaSwapTarget = typeof userMessageInput === "string" ? detectPersonaSwapCommand(userMessageInput) : null;
  if (personaSwapTarget && sessionKey) {
    applyPersonaSwap(key.surfaceId, personaSwapTarget).catch(() => {});
  }

  // Quota check — enforce per-agent rate/token limits
  const quotaCheck = await checkQuota(agentConfig.id, agentConfig.tier ?? "premium").catch(() => ({ allowed: true as const }));
  if (!quotaCheck.allowed) {
    throw new Error(`Quota exceeded for agent ${agentConfig.id}: ${(quotaCheck as any).reason}`);
  }

  // Data residency check — verify provider is allowed for this workspace
  if (workspaceId) {
    const residencyOk = await checkDataResidency(agentConfig.model.provider, workspaceId).catch(() => true);
    if (!residencyOk) {
      throw new Error(`Data residency policy blocks provider "${agentConfig.model.provider}" for workspace ${workspaceId}`);
    }
  }

  // Load balancer: track active session count for this agent
  incrementActiveSessions(agentConfig.id).catch(() => {});

  const traceId = randomUUID();
  const tracePrefix = `[${traceId.slice(0, 8)}]`;

  // Per-turn tool result cache — deduplicate identical calls within this turn
  const toolCache = new Map<string, string>(); // key=name:argHash, value=content

  // 1. Resolve session
  const { session, messages: existingMessages, isNew } = await resolveSession(
    key,
    agentConfig,
    workspaceId,
    webhookUrl,
  );

  const tracer = new AgentTracer({
    traceId,
    sessionId: session.id,
    agentId: agentConfig.id,
    uid,
    workspaceId,
  });
  tracer.start();

  // Load memory profile for this agent (controls tier enabling, chunk limits, prompt suffix)
  const memoryProfile = await getAgentProfile(agentConfig.id, workspaceId ?? "").catch(() => null);
  const profileConfig = memoryProfile?.config;

  // Cross-session context bridge: warm-start new sessions with prior context.
  // If this agent is running inside a swarm, check the shared L1 cache first to
  // avoid redundant memory fetches across sibling agents.
  let sessionBridgeContext = "";
  if (isNew) {
    const bridgeCacheKey = `session-context:${uid}:${agentConfig.id}`;
    const cachedBridge = swarmId ? getSwarmCache(swarmId, bridgeCacheKey) : null;
    if (cachedBridge) {
      sessionBridgeContext = cachedBridge.content;
    } else {
      sessionBridgeContext = await buildSessionContext(uid, agentConfig.id).catch(() => "");
      if (swarmId && sessionBridgeContext) {
        setSwarmCache(swarmId, bridgeCacheKey, {
          content: sessionBridgeContext,
          tier: 1,
          score: 1.0,
        });
      }
    }
  }

  // Cross-session entity linking: on new sessions, reinforce graph entities mentioned in the first message
  if (isNew && userMessage.length > 20) {
    graphSearch(uid, userMessage, 3)
      .then((results) => {
        for (const r of results) {
          if (r.score > 0.7) {
            reinforceEntity(r.entity.id, 0.05).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  // Emit agent.started + presence
  const bus = getEventBus();
  bus.emit("agent.started", {
    uid,
    agentId: agentConfig.id,
    sessionId: session.id,
    traceId,
    timestamp: Date.now(),
  });
  emitAgentStarted(uid, agentConfig.id, session.id);
  updatePresence(agentConfig.id, workspaceId ?? uid, "processing", userMessage.slice(0, 100));

  // 2. Persist user message
  const userMsg = await persistMessage(uid, session.id, {
    role: "user",
    content: userMessage,
    tokenEstimate: Math.ceil(userMessage.length / 4),
    timestamp: Date.now(),
  }, workspaceId);

  // Build the running message list (existing + new user message)
  let allMessages: MessageDoc[] = [...existingMessages, userMsg];

  // Check if compaction is needed before inference
  if (shouldCompact(allMessages, agentConfig)) {
    console.log(`${tracePrefix} Session ${session.id} needs compaction (${allMessages.length} messages)`);

    // Step 1: Pre-compaction flush — agent saves durable memories
    await preCompactionFlush(uid, session.id, allMessages, agentConfig, inferenceClient);

    // Step 2: Compact — summarize older messages, keep recent ones
    allMessages = await compactSession(uid, session.id, allMessages, agentConfig, inferenceClient);

    console.log(`${tracePrefix} Compacted to ${allMessages.length} messages`);
  }

  // Resolve tool policy — merge skill tool names into the allow set
  const skillTools = getSkillToolNames(agentConfig.skills ?? []);
  const mergedAllow = [...new Set([...agentConfig.tools.allow, ...skillTools])];
  const policy = resolveToolPolicy(
    [], // no global tools yet
    mergedAllow,
    agentConfig.tools.deny,
  );
  const toolSchemas = getToolSchemas(policy.allow);

  // Tool results collected across rounds
  const allToolResults: ToolResult[] = [];
  let totalUsage = { prompt: 0, completion: 0, total: 0, cached: 0 };

  // Latency tracking (#5)
  let contextAssemblyMs = 0;
  let inferenceMs = 0;
  let toolExecutionMs = 0;

  // Adaptive temperature (#3)
  let adaptiveTemp = agentConfig.model.temperature;
  let turnErrorCount = 0;

  // Wave 1: Fetch initial mood for this session (fire-and-forget read; fallback to neutral)
  const pool = getPool();
  const currentMood = await getMood(session.id, pool).catch(() => "neutral" as const);
  const moodSuffix = getMoodSystemSuffix(currentMood);
  // Combine mood suffix with any memory profile suffix + session bridge context
  const combinedSuffix = (profileConfig?.systemPromptSuffix ?? "") + moodSuffix + (sessionBridgeContext ? "\n\n" + sessionBridgeContext : "");

  // 3–6. Inference + tool loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Feature 4: Persona detection — detect from last user message
    // persona overlay would be applied in context assembly if agentConfig.personas[detected] exists
    void (round === 0 ? detectPersonaContext(userMessage) : null);

    // 3. Assemble context
    const assembleStart = Date.now();
    const { messages: contextMessages, estimatedTokens } = await assembleContext(
      uid,
      agentConfig,
      allMessages,
      toolSchemas,
      workspaceId,
      combinedSuffix || undefined,
      profileConfig,
      round === 0 ? multimodalParts : null,
    );
    contextAssemblyMs += Date.now() - assembleStart;

    // Token budget pre-flight — trim tool schemas if over budget (#1)
    let finalContextMessages = contextMessages;
    const tokenBudget = agentConfig.model.maxContextTokens;
    const overBudget = estimatedTokens + agentConfig.model.maxOutputTokens - tokenBudget;
    if (overBudget > 0 && toolSchemas.length > 0) {
      console.log(`${tracePrefix} Over budget by ~${overBudget} tokens, trimming tool schemas`);
      const trimmedSchemas = trimToolSchemas(toolSchemas, overBudget);
      const reAssembleStart = Date.now();
      const reAssembled = await assembleContext(uid, agentConfig, allMessages, trimmedSchemas, workspaceId, combinedSuffix || undefined, profileConfig, round === 0 ? multimodalParts : null);
      contextAssemblyMs += Date.now() - reAssembleStart;
      finalContextMessages = reAssembled.messages;
    }

    // Semantic cache check — only on first round with no tools (pure chat)
    if (round === 0 && toolSchemas.length === 0 && process.env.SEMANTIC_CACHE_ENABLED === "true") {
      const cached = await getSemanticCache(userMessage, agentConfig.id).catch(() => null);
      if (cached) {
        await persistMessage(uid, session.id, {
          role: "assistant",
          content: cached.content,
          tokenEstimate: Math.ceil(cached.content.length / 4),
          timestamp: Date.now(),
        }, workspaceId);
        emitAgentCompleted(uid, agentConfig.id, session.id);
        tracer.finish("completed");
        updatePresence(agentConfig.id, workspaceId ?? uid, "idle");
        return {
          content: cached.content,
          toolResults: [],
          sessionId: session.id,
          tokenUsage: { prompt: 0, completion: 0, total: 0, cached: 0 },
        };
      }
    }

    // After 8 tool rounds, stop offering tools to force the model to respond
    const TOOL_CUTOFF_ROUND = 8;
    const effectiveTools = round >= TOOL_CUTOFF_ROUND ? [] : toolSchemas;
    if (round === TOOL_CUTOFF_ROUND && toolSchemas.length > 0) {
      finalContextMessages = [
        ...finalContextMessages,
        {
          role: "user" as const,
          content: "[SYSTEM: Research phase complete — you have used all available tool rounds. Write your final response now using the data you have gathered. Do not attempt further tool calls.]",
        },
      ];
    }

    // 4. Call inference
    const inferStart = Date.now();
    const inferenceRequest = {
      messages: finalContextMessages,
      tools: effectiveTools.length > 0 ? effectiveTools : undefined,
      temperature: adaptiveTemp,
      maxTokens: agentConfig.model.maxOutputTokens,
      sessionId: session.id,
      useExtendedThinking: agentConfig.model.useExtendedThinking,
      budgetThinkingTokens: agentConfig.model.budgetThinkingTokens,
    };
    const turnCached = getTurnCache(inferenceRequest);
    let response: import("../inference/types.js").InferenceResponse;
    if (turnCached) {
      response = { content: turnCached, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
    } else {
      response = await inferenceClient.chat(inferenceRequest);
    }
    const inferenceElapsed = Date.now() - inferStart;
    inferenceMs += inferenceElapsed;
    totalUsage.prompt += response.usage.promptTokens;
    totalUsage.completion += response.usage.completionTokens;
    totalUsage.total += response.usage.totalTokens;
    totalUsage.cached += response.usage.cachedTokens ?? 0;
    if (response.usage.thinkingTokens !== undefined) {
      (totalUsage as any).thinkingTokens = ((totalUsage as any).thinkingTokens ?? 0) + response.usage.thinkingTokens;
    }

    // Emit inference audit event
    try {
      bus.emit("inference.request", {
        uid,
        agentId: agentConfig.id,
        sessionId: session.id,
        provider: agentConfig.model.provider,
        modelId: agentConfig.model.modelId,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
        durationMs: inferenceElapsed,
        cached: (response.usage.cachedTokens ?? 0) > 0,
        traceId,
        timestamp: Date.now(),
      });
    } catch (_) {
      // never break the agent loop for audit events
    }

    // Write full payload to inference_payloads table (fire-and-forget)
    writeInferencePayload({
      uid,
      agentId: agentConfig.id,
      sessionId: session.id,
      provider: agentConfig.model.provider,
      modelId: agentConfig.model.modelId,
      requestMessages: finalContextMessages,
      toolSchemas: toolSchemas.length > 0 ? toolSchemas : undefined,
      responseContent: response.content ?? undefined,
      finishReason: response.finishReason,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      cachedTokens: response.usage.cachedTokens ?? 0,
      durationMs: inferenceElapsed,
      traceId,
    }).catch(() => {}); // never break agent loop

    // 5. Handle tool calls
    if (response.finishReason === "tool_calls" && response.toolCalls.length > 0) {
      // Per-turn tool call cap (#4)
      const cap = agentConfig.tools.maxToolCallsPerRound ?? 8;
      let toolCallsThisRound = response.toolCalls;
      if (toolCallsThisRound.length > cap) {
        console.log(`${tracePrefix} Capping tool calls: ${toolCallsThisRound.length} → ${cap}`);
        toolCallsThisRound = toolCallsThisRound.slice(0, cap);
      }

      // Persist the assistant's tool-calling message
      const assistantMsg = await persistMessage(uid, session.id, {
        role: "assistant",
        content: response.content ?? "",
        toolCalls: toolCallsThisRound.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        })),
        tokenEstimate: response.usage.completionTokens,
        timestamp: Date.now(),
      }, workspaceId);
      allMessages.push(assistantMsg);

      // Execute tool calls — reads in parallel, writes sequentially
      const toolCtx = {
        uid,
        agentId: agentConfig.id,
        sessionId: session.id,
        workspaceId,
        traceId,
        metadata: { userRole: "tool_runner" }, // default role; can be overridden by auth
      };

      // Feature 14: Evaluate skill conditions before executing tools
      // Filter out tools whose skills have unmet conditions
      let filteredToolCalls = toolCallsThisRound;
      try {
        const { getSkillForTool } = await import("../skills/registry.js");
        const filteredCalls: typeof toolCallsThisRound = [];
        for (const tc of toolCallsThisRound) {
          const skillId = getSkillForTool(tc.name);
          if (skillId) {
            const guardResult = await evaluateSkillConditions(skillId, agentConfig.id, toolCtx);
            if (!guardResult.allowed) {
              // Log guard rejection as tool error
              const errorMsg = guardResult.reason ?? "Skill execution not allowed";
              allToolResults.push({
                toolCallId: tc.id,
                name: tc.name,
                content: JSON.stringify({ error: errorMsg }),
                durationMs: 0,
                error: errorMsg,
              });
              continue;
            }
          }
          filteredCalls.push(tc);
        }
        filteredToolCalls = filteredCalls;
      } catch {
        // skill guards unavailable, proceed with all calls
      }

      // Feature 13: Check for tool composition chains
      // If consecutive tools are composable, chain them instead of parallel exec
      let toolCallsForExecution = filteredToolCalls;
      try {
        await buildToolDependencyGraph();
        // Check if reads have composable chains (2+ consecutive compatible tools)
        const { reads: baseReads } = partitionToolCalls(filteredToolCalls);
        const composableChains: Array<{
          indices: number[];
          toolNames: string[];
        }> = [];

        for (let i = 0; i < baseReads.length - 1; i++) {
          const current = baseReads[i];
          const next = baseReads[i + 1];
          // Check if current -> next are compatible
          const compat = await autoDiscoverComposition(current.name, next.name);

          if (compat.compatible && compat.score > 0.5) {
            // Try to build a longer chain
            const chainIndices = [i, i + 1];
            let lastIdx = i + 1;
            for (let j = i + 2; j < baseReads.length; j++) {
              const nextCompat = await autoDiscoverComposition(baseReads[lastIdx].name, baseReads[j].name);
              if (nextCompat.compatible && nextCompat.score > 0.5) {
                chainIndices.push(j);
                lastIdx = j;
              } else {
                break;
              }
            }
            if (chainIndices.length >= 2) {
              composableChains.push({
                indices: chainIndices,
                toolNames: chainIndices.map((idx) => baseReads[idx].name),
              });
            }
          }
        }

        // If chains found, execute them specially
        if (composableChains.length > 0) {
          const usedIndices = new Set<number>();
          for (const chain of composableChains) {
            for (const idx of chain.indices) usedIndices.add(idx);
          }

          // For now, log but don't execute chains (preserve backward compat)
          // Future: execute chains via chainToolExecution()
          for (const chain of composableChains) {
            logger.info(`[composition] detected chain: ${chain.toolNames.join(" -> ")}`);
          }
        }
      } catch {
        // tool composition unavailable, continue normally
      }

      const { reads, writes } = partitionToolCalls(toolCallsForExecution);
      // Results collected in original order
      const resultMap = new Map<string, { tc: { id: string; name: string; arguments: string }; result: ToolResult }>();

      // Execute reads in parallel
      if (reads.length > 0) {
        const readPromises = reads.map(async (tc) => {
          const argHash = createHash("sha256").update(tc.arguments).digest("hex").slice(0, 16);
          const cacheKey = `${tc.name}:${argHash}`;
          const cachedContent = toolCache.get(cacheKey);
          if (cachedContent !== undefined) {
            resultMap.set(tc.id, {
              tc,
              result: { toolCallId: tc.id, name: tc.name, content: cachedContent, durationMs: 0 },
            });
            return;
          }

          emitToolCallStart(uid, agentConfig.id, session.id, tc.name);
          const toolStart = Date.now();
          const result = await executeTool(
            { id: tc.id, name: tc.name, arguments: tc.arguments },
            toolCtx,
            policy.allow,
          );
          toolExecutionMs += Date.now() - toolStart;
          emitToolCallEnd(uid, agentConfig.id, session.id);
          bus.emit("tool.executed", {
            uid,
            agentId: agentConfig.id,
            sessionId: session.id,
            toolName: result.name,
            durationMs: result.durationMs,
            error: result.error,
            traceId,
            timestamp: Date.now(),
          });
          toolCache.set(cacheKey, result.content);
          resultMap.set(tc.id, { tc, result });
        });
        await Promise.all(readPromises);
      }

      // Execute writes sequentially
      for (const tc of writes) {
        const argHash = createHash("sha256").update(tc.arguments).digest("hex").slice(0, 16);
        const cacheKey = `${tc.name}:${argHash}`;
        const cachedContent = toolCache.get(cacheKey);
        if (cachedContent !== undefined) {
          resultMap.set(tc.id, {
            tc,
            result: { toolCallId: tc.id, name: tc.name, content: cachedContent, durationMs: 0 },
          });
          continue;
        }

        emitToolCallStart(uid, agentConfig.id, session.id, tc.name);
        const toolStart = Date.now();
        const result = await executeTool(
          { id: tc.id, name: tc.name, arguments: tc.arguments },
          toolCtx,
          policy.allow,
        );
        toolExecutionMs += Date.now() - toolStart;
        emitToolCallEnd(uid, agentConfig.id, session.id);
        bus.emit("tool.executed", {
          uid,
          agentId: agentConfig.id,
          sessionId: session.id,
          toolName: result.name,
          durationMs: result.durationMs,
          error: result.error,
          traceId,
          timestamp: Date.now(),
        });
        toolCache.set(cacheKey, result.content);
        resultMap.set(tc.id, { tc, result });
      }

      // Persist results in original order (with redaction)
      const roundResults: ToolResult[] = [];
      for (const tc of toolCallsThisRound) {
        const entry = resultMap.get(tc.id);
        if (!entry) continue;
        roundResults.push(entry.result);
      }

      // Redact secrets and PII from all tool results before persistence
      const { results: redactedResults } = redactToolResults(roundResults);

      for (let i = 0; i < toolCallsThisRound.length; i++) {
        const tc = toolCallsThisRound[i];
        const entry = resultMap.get(tc.id);
        if (!entry) continue;
        const redactedResult = redactedResults[i];
        allToolResults.push(redactedResult);
        tracer.addToolCall(redactedResult.name, redactedResult.durationMs, redactedResult.error);

        // Tool result truncation: store full content in tool_outputs if > 500 chars
        let persistContent = redactedResult.content;
        if (redactedResult.content.length > 500) {
          persistContent = redactedResult.content.slice(0, 500) + " [truncated, full output stored]";
          // Fire-and-forget insert into tool_outputs
          getPool().query(
            `INSERT INTO tool_outputs (session_id, tool_call_id, tool_name, full_content)
             VALUES ($1, $2, $3, $4)`,
            [session.id, tc.id, redactedResult.name, redactedResult.content],
          ).catch(() => {});
        }

        const toolMsg = await persistMessage(uid, session.id, {
          role: "tool",
          content: persistContent,
          toolCallId: tc.id,
          tokenEstimate: Math.ceil(persistContent.length / 4),
          timestamp: Date.now(),
        }, workspaceId);
        allMessages.push(toolMsg);
      }

      // Count tool errors for adaptive temperature (#3)
      for (const r of allToolResults.slice(-toolCallsThisRound.length)) {
        if (r.error) turnErrorCount++;
      }
      // Adaptive temperature: lower on errors, restore on clean turns
      if (turnErrorCount > 0) {
        adaptiveTemp = Math.max(0.1, adaptiveTemp - 0.1 * turnErrorCount);
      } else if (round > 0) {
        adaptiveTemp = Math.min(agentConfig.model.temperature, adaptiveTemp + 0.05);
      }

      // Wave 1: Update mood based on tool success/error (fire-and-forget)
      const lastBatch = allToolResults.slice(-toolCallsThisRound.length);
      const batchHasError = lastBatch.some((r) => r.error);
      updateMood(session.id, batchHasError ? "error" : "success", pool).catch(() => {});

      // Loop back for the model to process tool results
      continue;
    }

    // 6. No tool calls — we have the final response
    let finalContent = response.content ?? "";

    // Redact secrets from final response before storing
    const redactedFinalResult = redactToolResults([
      { toolCallId: "", name: "final-response", content: finalContent, durationMs: 0 },
    ]).results[0];
    if (redactedFinalResult) {
      finalContent = redactedFinalResult.content;
    }

    // Store in turn hash cache — only cache pure text responses (no tool calls)
    if (!turnCached && finalContent) {
      setTurnCache(inferenceRequest, finalContent);
    }

    // Optional reflection pass — only on complex/uncertain turns
    let revisedContent = finalContent;
    if (shouldReflect(allToolResults, finalContent.length)) {
      const reflection = await reflectOnResponse(userMessage, finalContent, inferenceClient, session.id).catch(() => null);
      if (reflection?.shouldRevise) {
        // One more inference pass with reflection feedback
        const reflectionMessages = [
          ...finalContextMessages,
          { role: "assistant" as const, content: finalContent },
          { role: "user" as const, content: `Please revise your response based on this feedback: ${reflection.issues.join("; ")}` },
        ];
        const revised = await inferenceClient.chat({
          messages: reflectionMessages,
          temperature: agentConfig.model.temperature,
          maxTokens: agentConfig.model.maxOutputTokens,
          sessionId: session.id,
        }).catch(() => null);
        if (revised?.content) {
          revisedContent = revised.content;
          totalUsage.prompt += revised.usage.promptTokens;
          totalUsage.completion += revised.usage.completionTokens;
          totalUsage.total += revised.usage.totalTokens;
          totalUsage.cached += revised.usage.cachedTokens ?? 0;
        }
      }
    }

    // Feature 11: Self-critique pass
    const shouldCritique =
      agentConfig.selfCritique?.enabled &&
      (agentConfig.selfCritique.triggers?.includes("always") ||
        (agentConfig.selfCritique.triggers?.includes("tool_error") &&
          allToolResults.some((r) => r.error)) ||
        (agentConfig.selfCritique.triggers?.includes("long_response") &&
          revisedContent.length > 2000) ||
        (agentConfig.selfCritique.triggers?.includes("low_confidence") &&
          agentConfig.confidenceThreshold !== undefined &&
          extractConfidenceSignals(revisedContent) < agentConfig.confidenceThreshold));

    if (shouldCritique) {
      const critiqueResult = await runSelfCritique(
        revisedContent,
        inferenceClient,
        agentConfig.model.maxOutputTokens,
        agentConfig.selfCritique!.passes,
      ).catch(() => null);
      if (critiqueResult) {
        revisedContent = critiqueResult.revised;
        // Account for critique pass token usage
        (totalUsage as any).critiqueTokens =
          ((totalUsage as any).critiqueTokens ?? 0) + 500 * critiqueResult.passes;
        // Fire-and-forget event
        bus.emit("agent.critique_completed" as any, {
          uid,
          agentId: agentConfig.id,
          sessionId: session.id,
          passes: critiqueResult.passes,
          critiqueCount: critiqueResult.critiques.length,
          durationMs: critiqueResult.durationMs,
          timestamp: Date.now(),
        });
      }
    }

    await persistMessage(uid, session.id, {
      role: "assistant",
      content: revisedContent,
      tokenEstimate: response.usage.completionTokens,
      timestamp: Date.now(),
    }, workspaceId);

    emitAgentCompleted(uid, agentConfig.id, session.id);

    // Feature 3: Confidence check
    const confidence = extractConfidenceSignals(revisedContent);
    if (agentConfig.confidenceThreshold !== undefined && confidence < agentConfig.confidenceThreshold) {
      bus.emit("agent.low_confidence" as any, {
        uid, agentId: agentConfig.id, sessionId: session.id,
        confidence, threshold: agentConfig.confidenceThreshold, traceId, timestamp: Date.now(),
      });
    }

    // Wave 1: Tone drift detection
    if (agentConfig.expectedTone) {
      const actualTone = classifyTone(revisedContent);
      const drift = detectToneDrift(agentConfig.expectedTone, actualTone);
      if (drift.drifted) {
        bus.emit("agent.tone_drift" as any, {
          uid,
          agentId: agentConfig.id,
          sessionId: session.id,
          expectedTone: drift.expectedTone,
          actualTone: drift.actualTone,
          severity: drift.severity,
          traceId,
          timestamp: Date.now(),
        });
      }
    }

    // Feature 17: Handoff detection
    if (agentConfig.handoffTargets && agentConfig.handoffTargets.length > 0) {
      const handoff = detectHandoffSignal(revisedContent);
      if (handoff && agentConfig.handoffTargets.includes(handoff.targetAgentId)) {
        bus.emit("agent.handoff" as any, {
          uid, agentId: agentConfig.id, targetAgentId: handoff.targetAgentId,
          sessionId: session.id, traceId, timestamp: Date.now(),
        });
      }
    }

    // Feature 2: Goals context — fire-and-forget pre-load for next turn
    if (workspaceId) {
      loadActiveGoals(agentConfig.id, uid, workspaceId).then((goals) => {
        void buildGoalContext(goals); // pre-loads goal context for next turn assembly
      }).catch(() => {});
    }

    bus.emit("agent.completed", {
      uid,
      agentId: agentConfig.id,
      sessionId: session.id,
      content: revisedContent,
      workspaceId,
      tokenUsage: totalUsage,
      toolResults: allToolResults.map((r) => ({
        name: r.name,
        durationMs: r.durationMs,
        error: r.error,
      })),
      traceId,
      timestamp: Date.now(),
    });

    // Fire-and-forget webhook for agent_completed
    fireWebhooksForEvent(uid, "agent_completed", {
      agentId: agentConfig.id,
      sessionId: session.id,
      content: revisedContent,
      tokenUsage: totalUsage,
    }).catch(() => {});

    // Fire session-scoped output webhook if one was registered at session creation
    fireSessionWebhook(session.webhookUrl, {
      sessionId: session.id,
      agentId: agentConfig.id,
      content: revisedContent,
      tokenUsage: totalUsage,
      toolResults: allToolResults.map((r) => ({ name: r.name, durationMs: r.durationMs, error: r.error })),
      timestamp: Date.now(),
    });

    // Store in semantic cache (fire-and-forget) — only cache clean responses (no tools used)
    if (process.env.SEMANTIC_CACHE_ENABLED === "true" && allToolResults.length === 0) {
      setSemanticCache(userMessage, revisedContent, agentConfig.id).catch(() => {});
    }

    // 7. Post-turn auto-save — extract key facts from user message + response
    postTurnAutoSave(uid, userMessage, revisedContent).catch(() => {});

    // Feature 8: Memory refinement (fire-and-forget)
    if (agentConfig.refinement?.enabled) {
      refineMemoriesForSession(uid, session.id, allMessages).catch(() => {});
    }

    // Save session summary for context bridge (fire-and-forget)
    saveSessionSummary(uid, agentConfig.id, session.id, {
      summary: revisedContent.slice(0, 500),
      topics: [],
      keyDecisions: [],
      pendingActions: [],
      messageCount: allMessages.length,
      durationMinutes: Math.round((Date.now() - (allMessages[0]?.timestamp ?? Date.now())) / 60_000),
    }).catch(() => {});

    tracer.setTokens(totalUsage.prompt, totalUsage.completion, totalUsage.total);
    tracer.finish("completed");

    // Emit latency metrics event (#5)
    bus.emit("agent.metrics" as any, {
      uid,
      agentId: agentConfig.id,
      sessionId: session.id,
      traceId,
      contextAssemblyMs,
      inferenceMs,
      toolExecutionMs,
      totalTokens: totalUsage.total,
      thinkingTokens: (totalUsage as any).thinkingTokens,
      critiqueTokens: (totalUsage as any).critiqueTokens,
      round,
      timestamp: Date.now(),
    });

    // Compaction window forecasting (#6)
    const currentMsgTokens = allMessages.reduce((s, m) => s + (m.tokenEstimate ?? Math.ceil(m.content.length / 4)), 0);
    const compactionThreshold = agentConfig.model.maxContextTokens * 0.7;
    const avgTokensPerTurn = currentMsgTokens / Math.max(1, Math.floor(allMessages.length / 2));
    const turnsUntilCompaction = Math.floor((compactionThreshold - currentMsgTokens) / Math.max(1, avgTokensPerTurn));
    if (turnsUntilCompaction > 0 && turnsUntilCompaction <= 5) {
      console.log(`${tracePrefix} Compaction forecast: ~${turnsUntilCompaction} turns remaining — pre-saving memories`);
      postTurnAutoSave(uid, userMessage, revisedContent).catch(() => {});
    }

    updatePresence(agentConfig.id, workspaceId ?? uid, "idle");

    // Record quota usage for this turn
    // Cost estimate in cents: use per-provider average cost per 1M tokens
    const COST_PER_MILLION: Record<string, number> = {
      gemini: 50,     // Gemini Flash ~$0.10-0.40/M input, higher output → ~$0.50/M blended
      groq: 20,       // Groq ~$0.20/M
      grok: 200,      // Grok ~$2/M
      claude: 900,    // Claude Sonnet ~$9/M (blended in/out)
      openai: 500,    // GPT-4o ~$5/M (blended in/out)
      ollama: 0,      // Local, no cost
      vllm: 0,        // Local, no cost
      openrouter: 300, // Varies, ~$3/M avg
      mistral: 60,    // Mistral ~$0.60/M
      bedrock: 800,   // Bedrock ~$8/M avg
    };
    const costPerMillion = COST_PER_MILLION[agentConfig.model.provider] ?? 300;
    const costCents = Math.round((totalUsage.total / 1_000_000) * costPerMillion);
    recordTokenUsage(agentConfig.id, totalUsage.total, costCents).catch(() => {});
    decrementActiveSessions(agentConfig.id).catch(() => {});

    return {
      content: revisedContent,
      toolResults: allToolResults,
      sessionId: session.id,
      tokenUsage: totalUsage,
    };
  }

  // Safety: if we exhausted tool rounds, return whatever we have
  const fallback =
    "I've been working through several steps but hit my processing limit. Could you rephrase or simplify your request?";

  await persistMessage(uid, session.id, {
    role: "assistant",
    content: fallback,
    tokenEstimate: Math.ceil(fallback.length / 4),
    timestamp: Date.now(),
  }, workspaceId);

  tracer.setTokens(totalUsage.prompt, totalUsage.completion, totalUsage.total);
  tracer.finish("timeout");

  decrementActiveSessions(agentConfig.id).catch(() => {});

  return {
    content: fallback,
    toolResults: allToolResults,
    sessionId: session.id,
    tokenUsage: totalUsage,
  };
}
