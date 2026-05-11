import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig } from "./types.js";
import type { SessionKey, MessageDoc } from "../sessions/types.js";
import type { InferenceClient } from "../inference/types.js";
import type { ToolResult } from "../tools/types.js";
import type { ToolSchema } from "../inference/types.js";
import type { AgentStreamEvent } from "./stream-types.js";
import { resolveSession, persistMessage } from "../sessions/store.js";
import { shouldCompact, preCompactionFlush, compactSession } from "../sessions/compaction.js";
import { assembleContext, trimToolSchemas } from "../context/assembler.js";
import { getToolSchemas, executeTool } from "../tools/index.js";
import { resolveToolPolicy } from "../tools/types.js";
import { getEventBus } from "../events/index.js";
import { emitAgentStarted, emitAgentStreaming, emitToolCallStart, emitToolCallEnd, emitAgentCompleted } from "./lifecycle.js";
import { getSkillToolNames } from "../skills/registry.js";
import { postTurnAutoSave } from "./post-turn-save.js";
import { graphSearch } from "../memory/graph.js";
import { reinforceEntity } from "../memory/auto-extract.js";
import { getPool } from "../config/postgres.js";
import { shouldReflect, reflectOnResponse } from "./reflection.js";
import { AgentTracer } from "./tracer.js";
import { getAgentProfile } from "../memory/profiles.js";
import { writeInferencePayload } from "../inference/payload-audit.js";
import { getSemanticCache, setSemanticCache } from "../cache/semantic.js";
import { extractConfidenceSignals } from "./confidence.js";
import { detectPersonaContext } from "./persona.js";
import { loadActiveGoals, buildGoalContext } from "./goals.js";
import { getMood, updateMood, getMoodSystemSuffix } from "./mood.js";
import { buildSessionContext, saveSessionSummary } from "../memory/context-bridge.js";
import { classifyTone, detectToneDrift } from "./tone-drift.js";
import type { MessageInput } from "./message-input.js";
import { normalizeMessageInput, toContentParts } from "./message-input.js";
import { updatePresence } from "./presence.js";

// ── Streaming Agent Loop ────────────────────────────────────────────
// Same logic as runAgentLoop but yields AgentStreamEvents as an
// AsyncGenerator. Uses chatStream() for real-time token streaming.

const MAX_TOOL_ROUNDS = 10;
const QUIET = () => !!process.env.ASTRA_STANDALONE;

// ── Uncertainty Detection ───────────────────────────────────────────
// Detects LLM self-reported inability to answer — triggers web search retry.
const UNCERTAINTY_PATTERNS = [
  /i (?:don't|do not|cannot|can't|am not able to|am unable to) (?:have )?(?:access|browse|search|look up|find|check|verify)/i,
  /as of my (?:knowledge cutoff|last (?:update|training)|training)/i,
  /(?:don't|do not) have (?:current|real-?time|up-to-date|latest|recent) (?:information|data|access)/i,
  /(?:i'm|i am) unable to (?:search|browse|access|look up|fetch)/i,
  /i (?:can't|cannot) (?:browse|search|access) the (?:web|internet)/i,
];

function looksUncertain(content: string): boolean {
  return UNCERTAINTY_PATTERNS.some((p) => p.test(content));
}

export async function* runAgentLoopStream(
  uid: string,
  userMessageInput: string | MessageInput,
  agentConfig: AgentConfig,
  inferenceClient: InferenceClient,
  sessionKey?: SessionKey,
  signal?: AbortSignal,
  workspaceId?: string,
  toolSchemaFilter?: (schemas: ToolSchema[], userMessage: string) => ToolSchema[],
): AsyncGenerator<AgentStreamEvent> {
  const userMessage = typeof userMessageInput === "string"
    ? userMessageInput
    : normalizeMessageInput(userMessageInput);

  // Extract multimodal content parts for vision-capable agents
  const isVisionCapable = agentConfig.model.capabilities?.includes("vision") ?? false;
  const multimodalParts = isVisionCapable && typeof userMessageInput !== "string"
    ? toContentParts(userMessageInput)
    : null;

  const key: SessionKey = sessionKey ?? {
    uid,
    surface: "chat",
    surfaceId: "main",
  };

  const traceId = randomUUID();
  const tracePrefix = `[${traceId.slice(0, 8)}]`;

  // Per-turn tool result cache — deduplicate identical calls within this turn
  const toolCache = new Map<string, string>(); // key=name:argHash, value=content

  const bus = getEventBus();

  // 1. Resolve session
  const { session, messages: existingMessages, isNew } = await resolveSession(
    key,
    agentConfig,
    workspaceId,
  );

  // Cross-session context bridge: warm-start new sessions with prior context
  let sessionBridgeContext = "";
  if (isNew) {
    sessionBridgeContext = await buildSessionContext(uid, agentConfig.id).catch(() => "");
  }

  // Cross-session entity linking: on new sessions, reinforce graph entities mentioned in the first message (#10)
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

  // Fetch initial mood for this session (fire-and-forget read; fallback to neutral)
  const pool = getPool();
  const currentMood = await getMood(session.id, pool).catch(() => "neutral" as const);
  const moodSuffix = getMoodSystemSuffix(currentMood);
  // Combine mood suffix with any memory profile suffix + session bridge context
  const combinedSuffix = (profileConfig?.systemPromptSuffix ?? "") + moodSuffix + (sessionBridgeContext ? "\n\n" + sessionBridgeContext : "");

  // Subscribe to branch events for this session so we can yield them to the stream
  const branchEventQueue: AgentStreamEvent[] = [];
  const unsubBranchCreated = (bus as any).on("conversation.branched", (evt: Record<string, unknown>) => {
    if (evt.parentSessionId === session.id || evt.branchSessionId === session.id) {
      branchEventQueue.push({
        type: "branch_created",
        branchId: evt.branchId as string,
        branchSessionId: evt.branchSessionId as string,
        parentSessionId: evt.parentSessionId as string,
        fromMessageIndex: evt.fromMessageIndex as number,
        label: evt.label as string | undefined,
      });
    }
  }) as () => void;
  const unsubBranchSwitched = (bus as any).on("conversation.branch_switched", (evt: Record<string, unknown>) => {
    if (evt.parentSessionId === session.id || evt.branchSessionId === session.id) {
      branchEventQueue.push({
        type: "branch_switched",
        branchId: evt.branchId as string,
        branchSessionId: evt.branchSessionId as string,
        parentSessionId: evt.parentSessionId as string,
      });
    }
  }) as () => void;

  yield { type: "session_resolved", sessionId: session.id, isNew };

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

  let allMessages: MessageDoc[] = [...existingMessages, userMsg];

  // Check compaction
  if (shouldCompact(allMessages, agentConfig)) {
    if (!QUIET()) console.log(`${tracePrefix} Session ${session.id} needs compaction (${allMessages.length} messages)`);
    await preCompactionFlush(uid, session.id, allMessages, agentConfig, inferenceClient);
    allMessages = await compactSession(uid, session.id, allMessages, agentConfig, inferenceClient);
    if (!QUIET()) console.log(`${tracePrefix} Compacted to ${allMessages.length} messages`);
  }

  // Resolve tool policy — merge skill tool names into the allow set
  const skillTools = getSkillToolNames(agentConfig.skills ?? []);
  const mergedAllow = [...new Set([...agentConfig.tools.allow, ...skillTools])];
  const policy = resolveToolPolicy(
    [],
    mergedAllow,
    agentConfig.tools.deny,
  );
  let toolSchemas = getToolSchemas(policy.allow);
  if (toolSchemaFilter) {
    toolSchemas = toolSchemaFilter(toolSchemas, userMessage);
  }

  const allToolResults: ToolResult[] = [];
  let totalUsage = { prompt: 0, completion: 0, total: 0, cached: 0 };

  // Latency tracking (#5)
  let contextAssemblyMs = 0;
  let inferenceMs = 0;
  let toolExecutionMs = 0;

  // Adaptive temperature (#3)
  let adaptiveTemp = agentConfig.model.temperature;
  let turnErrorCount = 0;

  // Consecutive tool failure tracker — breaks retry spirals
  const toolFailCounts = new Map<string, number>();

  // 3–6. Inference + tool loop with streaming
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;

    // Persona detection — detect from last user message on first round
    void (round === 0 ? detectPersonaContext(userMessage) : null);

    yield { type: "inference_start", round };

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
      if (!QUIET()) console.log(`${tracePrefix} Over budget by ~${overBudget} tokens, trimming tool schemas`);
      const trimmedSchemas = trimToolSchemas(toolSchemas, overBudget);
      const reAssembleStart = Date.now();
      const reAssembled = await assembleContext(uid, agentConfig, allMessages, trimmedSchemas, workspaceId, profileConfig?.systemPromptSuffix, profileConfig, round === 0 ? multimodalParts : null);
      contextAssemblyMs += Date.now() - reAssembleStart;
      finalContextMessages = reAssembled.messages;
    }

    // Semantic cache check — only on first round with no tools (pure chat)
    if (round === 0 && toolSchemas.length === 0 && process.env.SEMANTIC_CACHE_ENABLED === "true") {
      const cached = await getSemanticCache(userMessage, agentConfig.id).catch(() => null);
      if (cached) {
        yield { type: "stream_delta", content: cached.content };
        yield { type: "inference_done", round, finishReason: "stop", usage: { prompt: 0, completion: 0, total: 0, cached: 0 } };
        await persistMessage(uid, session.id, {
          role: "assistant",
          content: cached.content,
          tokenEstimate: Math.ceil(cached.content.length / 4),
          timestamp: Date.now(),
        }, workspaceId);
        emitAgentCompleted(uid, agentConfig.id, session.id);
        tracer.finish("completed");
        updatePresence(agentConfig.id, workspaceId ?? uid, "idle");
        yield { type: "completed", content: cached.content, sessionId: session.id, tokenUsage: { prompt: 0, completion: 0, total: 0, cached: 0 } } as AgentStreamEvent;
        return;
      }
    }

    // After 8 tool rounds, stop offering tools to force the model to respond
    const TOOL_CUTOFF_ROUND = 8;
    const effectiveTools = round >= TOOL_CUTOFF_ROUND ? [] : toolSchemas;
    if (round === TOOL_CUTOFF_ROUND && toolSchemas.length > 0) {
      console.log(`${tracePrefix} Round ${round}: dropping tools to force text response`);
      // Inject a system nudge so the model knows to write now
      finalContextMessages = [
        ...finalContextMessages,
        {
          role: "user" as const,
          content: "[SYSTEM: Research phase complete — you have used all available tool rounds. Write your final response now using the data you have gathered. Do not attempt further tool calls.]",
        },
      ];
    }

    // Stream inference
    const inferStart = Date.now();
    const stream = inferenceClient.chatStream({
      messages: finalContextMessages,
      tools: effectiveTools.length > 0 ? effectiveTools : undefined,
      temperature: adaptiveTemp,
      maxTokens: agentConfig.model.maxOutputTokens,
      sessionId: session.id,
    });

    let fullContent = "";
    let streamingPresenceEmitted = false;
    // Accumulate tool call deltas: index → { id, name, arguments }
    const toolCallAccum = new Map<number, { id: string; name: string; arguments: string; thoughtSignature?: string }>();
    let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: string = "stop";

    for await (const delta of stream) {
      if (signal?.aborted) return;

      if (delta.type === "content" && delta.content) {
        if (!streamingPresenceEmitted) {
          emitAgentStreaming(uid, agentConfig.id, session.id);
          streamingPresenceEmitted = true;
        }
        fullContent += delta.content;
        yield { type: "stream_delta", content: delta.content };

        bus.emit("agent.stream.delta", {
          uid,
          agentId: agentConfig.id,
          sessionId: session.id,
          delta: delta.content,
          traceId,
          timestamp: Date.now(),
        });
      }

      if (delta.type === "tool_call" && delta.toolCall) {
        const tc = delta.toolCall;
        let accum = toolCallAccum.get(tc.index);

        if (!accum) {
          accum = { id: tc.id ?? "", name: tc.name ?? "", arguments: "", thoughtSignature: tc.thoughtSignature };
          toolCallAccum.set(tc.index, accum);

          if (tc.id && tc.name) {
            yield { type: "tool_call_start", index: tc.index, id: tc.id, name: tc.name };
          }
        }

        if (tc.id && !accum.id) accum.id = tc.id;
        if (tc.name && !accum.name) accum.name = tc.name;

        if (tc.arguments) {
          accum.arguments += tc.arguments;
          yield { type: "tool_call_args", index: tc.index, args: tc.arguments };
        }
      }

      if (delta.type === "done") {
        if (delta.usage) {
          streamUsage = delta.usage;
        }
      }
    }

    const inferenceElapsed = Date.now() - inferStart;
    inferenceMs += inferenceElapsed;
    totalUsage.prompt += streamUsage.promptTokens;
    totalUsage.completion += streamUsage.completionTokens;
    totalUsage.total += streamUsage.totalTokens;
    totalUsage.cached += streamUsage.cachedTokens ?? 0;

    // Emit inference audit event
    try {
      bus.emit("inference.request", {
        uid,
        agentId: agentConfig.id,
        sessionId: session.id,
        provider: agentConfig.model.provider,
        modelId: agentConfig.model.modelId,
        promptTokens: streamUsage.promptTokens,
        completionTokens: streamUsage.completionTokens,
        totalTokens: streamUsage.totalTokens,
        durationMs: inferenceElapsed,
        cached: (streamUsage.cachedTokens ?? 0) > 0,
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
      responseContent: fullContent,
      finishReason: toolCallAccum.size > 0 ? "tool_calls" : "stop",
      promptTokens: streamUsage.promptTokens,
      completionTokens: streamUsage.completionTokens,
      totalTokens: streamUsage.totalTokens,
      cachedTokens: streamUsage.cachedTokens ?? 0,
      durationMs: inferenceElapsed,
      traceId,
    }).catch(() => {}); // never break agent loop

    // Determine finish reason from accumulated tool calls
    const hasToolCalls = toolCallAccum.size > 0;
    finishReason = hasToolCalls ? "tool_calls" : "stop";

    yield {
      type: "inference_done",
      round,
      finishReason,
      usage: {
        prompt: streamUsage.promptTokens,
        completion: streamUsage.completionTokens,
        total: streamUsage.totalTokens,
        cached: streamUsage.cachedTokens ?? 0,
      },
    };

    // Handle tool calls
    if (hasToolCalls) {
      // Emit tool_call_complete for each accumulated call
      let toolCalls = [...toolCallAccum.entries()]
        .sort(([a], [b]) => a - b)
        .map(([idx, tc]) => {
          return { index: idx, ...tc };
        });

      // Per-turn tool call cap (#4)
      const cap = agentConfig.tools.maxToolCallsPerRound ?? 8;
      if (toolCalls.length > cap) {
        if (!QUIET()) console.log(`${tracePrefix} Capping tool calls: ${toolCalls.length} → ${cap}`);
        toolCalls = toolCalls.slice(0, cap);
      }

      for (const tc of toolCalls) {
        yield {
          type: "tool_call_complete",
          index: tc.index,
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        };
      }

      // Persist assistant's tool-calling message
      const assistantMsg = await persistMessage(uid, session.id, {
        role: "assistant",
        content: fullContent || "",
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        })),
        tokenEstimate: streamUsage.completionTokens,
        timestamp: Date.now(),
      }, workspaceId);
      allMessages.push(assistantMsg);

      // Execute tools sequentially
      const toolCtx = { uid, agentId: agentConfig.id, sessionId: session.id, workspaceId, traceId };

      for (const tc of toolCalls) {
        if (signal?.aborted) return;

        const argHash = createHash("sha256").update(tc.arguments).digest("hex").slice(0, 16);
        const cacheKey = `${tc.name}:${argHash}`;
        const cachedContent = toolCache.get(cacheKey);

        if (cachedContent !== undefined) {
          allToolResults.push({ toolCallId: tc.id, name: tc.name, content: cachedContent, durationMs: 0 });
          yield {
            type: "tool_result",
            toolCallId: tc.id,
            name: tc.name,
            content: cachedContent,
            durationMs: 0,
            error: undefined,
          };
          const toolMsg = await persistMessage(uid, session.id, {
            role: "tool",
            content: cachedContent,
            toolCallId: tc.id,
            tokenEstimate: Math.ceil(cachedContent.length / 4),
            timestamp: Date.now(),
          }, workspaceId);
          allMessages.push(toolMsg);
          continue;
        }

        emitToolCallStart(uid, agentConfig.id, session.id, tc.name);

        // Feature 4: Emit tool_progress at 0% before execution starts
        yield {
          type: "tool_progress",
          toolCallId: tc.id,
          name: tc.name,
          progress: 0,
          message: `Starting ${tc.name}...`,
        };

        const toolStart = Date.now();
        const result = await executeTool(
          { id: tc.id, name: tc.name, arguments: tc.arguments },
          toolCtx,
          policy.allow,
        );
        toolExecutionMs += Date.now() - toolStart;
        allToolResults.push(result);
        // Only cache successful results — caching errors causes the dedup
        // path to return them as successes (error: undefined), which confuses
        // the LLM and bypasses the consecutive failure counter.
        if (!result.error) {
          toolCache.set(cacheKey, result.content);
        }
        tracer.addToolCall(result.name, result.durationMs, result.error);

        emitToolCallEnd(uid, agentConfig.id, session.id);

        yield {
          type: "tool_result",
          toolCallId: result.toolCallId,
          name: result.name,
          content: result.content,
          durationMs: result.durationMs,
          error: result.error,
        };

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

        // Tool result truncation: store full content in tool_outputs if > 500 chars
        let persistContent = result.content;
        if (result.content.length > 500) {
          persistContent = result.content.slice(0, 500) + " [truncated, full output stored]";
          getPool().query(
            `INSERT INTO tool_outputs (session_id, tool_call_id, tool_name, full_content)
             VALUES ($1, $2, $3, $4)`,
            [session.id, tc.id, result.name, result.content],
          ).catch(() => {});
        }

        // Persist tool result
        const toolMsg = await persistMessage(uid, session.id, {
          role: "tool",
          content: persistContent,
          toolCallId: tc.id,
          tokenEstimate: Math.ceil(persistContent.length / 4),
          timestamp: Date.now(),
        }, workspaceId);
        allMessages.push(toolMsg);
      }

      // Count tool errors for adaptive temperature (#3) + consecutive failure tracking
      for (const r of allToolResults.slice(-toolCalls.length)) {
        if (r.error) {
          turnErrorCount++;
          toolFailCounts.set(r.name, (toolFailCounts.get(r.name) ?? 0) + 1);
        } else {
          toolFailCounts.delete(r.name); // reset on success
        }
      }

      // Inject failure hint when a tool fails repeatedly — breaks the
      // apologize→retry→fail spiral that wastes tokens and frustrates users
      const repeatedFailures = [...toolFailCounts.entries()].filter(([, c]) => c >= 2);
      if (repeatedFailures.length > 0) {
        const failedNames = repeatedFailures.map(([n]) => n).join(", ");
        const hintContent = `[System] The tool(s) "${failedNames}" have failed multiple times this session. Do NOT retry them with the same approach. Either: use a different tool, answer from your own knowledge, or tell the user you cannot complete this specific action and suggest an alternative.`;
        const hintMsg = await persistMessage(uid, session.id, {
          role: "system",
          content: hintContent,
          tokenEstimate: Math.ceil(hintContent.length / 4),
          timestamp: Date.now(),
        }, workspaceId);
        allMessages.push(hintMsg);
      }
      // Adaptive temperature: lower on errors, restore on clean turns
      if (turnErrorCount > 0) {
        adaptiveTemp = Math.max(0.1, adaptiveTemp - 0.1 * turnErrorCount);
      } else if (round > 0) {
        adaptiveTemp = Math.min(agentConfig.model.temperature, adaptiveTemp + 0.05);
      }

      // Update mood based on tool success/error (fire-and-forget)
      const lastBatch = allToolResults.slice(-toolCalls.length);
      const batchHasError = lastBatch.some((r) => r.error);
      updateMood(session.id, batchHasError ? "error" : "success", pool).catch(() => {});

      // Yield any queued branch events
      while (branchEventQueue.length > 0) {
        yield branchEventQueue.shift()!;
      }

      continue;
    }

    // No tool calls — final response
    const finalContent = fullContent || "";

    // Optimistic web search gating: if the LLM signals uncertainty and
    // web_search wasn't in the schema this round, retry once with it enabled.
    if (
      round === 0 &&
      !toolSchemas.some((s) => s.function.name === "web_search") &&
      policy.allow.has("web_search") &&
      looksUncertain(finalContent)
    ) {
      const wsSchemas = getToolSchemas(new Set(["web_search"]));
      toolSchemas = [...toolSchemas, ...wsSchemas];

      const hintContent = "You indicated uncertainty. Web search is now available — use it if needed.";
      const hintMsg = await persistMessage(uid, session.id, {
        role: "user",
        content: hintContent,
        tokenEstimate: Math.ceil(hintContent.length / 4),
        timestamp: Date.now(),
      }, workspaceId);
      allMessages.push(hintMsg);

      yield { type: "retry_web_search" };
      continue;
    }

    // Optional reflection pass — only on complex/uncertain turns
    let revisedContent = finalContent;
    if (shouldReflect(allToolResults, finalContent.length)) {
      const reflection = await reflectOnResponse(userMessage, finalContent, inferenceClient, session.id).catch(() => null);
      if (reflection?.shouldRevise) {
        // One more inference pass with reflection feedback (stream already sent original)
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

    await persistMessage(uid, session.id, {
      role: "assistant",
      content: revisedContent,
      tokenEstimate: streamUsage.completionTokens,
      timestamp: Date.now(),
    }, workspaceId);

    // ── Enrichments (parity with loop.ts) ──────────────────────────────

    // Confidence scoring
    const confidence = extractConfidenceSignals(revisedContent);
    if (agentConfig.confidenceThreshold !== undefined && confidence < agentConfig.confidenceThreshold) {
      bus.emit("agent.low_confidence" as any, {
        uid, agentId: agentConfig.id, sessionId: session.id,
        confidence, threshold: agentConfig.confidenceThreshold, traceId, timestamp: Date.now(),
      });
    }

    // Tone drift detection
    let toneDriftResult: { drifted: boolean; expectedTone: string; actualTone: string; severity: string } | null = null;
    if (agentConfig.expectedTone) {
      const actualTone = classifyTone(revisedContent);
      const drift = detectToneDrift(agentConfig.expectedTone, actualTone);
      toneDriftResult = drift;
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

    // Handoff detection
    if (agentConfig.handoffTargets && agentConfig.handoffTargets.length > 0) {
      const handoffMatch = revisedContent.match(/\[HANDOFF:\s*([^\]]+)\]/);
      if (handoffMatch) {
        const targetId = handoffMatch[1].trim();
        if (agentConfig.handoffTargets.includes(targetId)) {
          bus.emit("agent.handoff" as any, {
            uid, agentId: agentConfig.id, targetAgentId: targetId,
            sessionId: session.id, traceId, timestamp: Date.now(),
          });
        }
      }
    }

    // Goals context — fire-and-forget pre-load for next turn
    let goalTitles: string[] = [];
    if (workspaceId) {
      loadActiveGoals(agentConfig.id, uid, workspaceId).then((goals) => {
        goalTitles = goals.map((g) => g.title);
        void buildGoalContext(goals); // pre-loads goal context for next turn assembly
      }).catch(() => {});
    }

    // Persona detection result
    const personaCtx = detectPersonaContext(userMessage);

    // Update mood after final response
    const finalMood = await getMood(session.id, pool).catch(() => "neutral" as const);

    // Store in semantic cache (fire-and-forget) — only cache clean responses (no tools used)
    if (process.env.SEMANTIC_CACHE_ENABLED === "true" && allToolResults.length === 0) {
      setSemanticCache(userMessage, revisedContent, agentConfig.id).catch(() => {});
    }

    // Post-turn auto-save (fire-and-forget)
    postTurnAutoSave(uid, userMessage, revisedContent).catch(() => {});

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

    emitAgentCompleted(uid, agentConfig.id, session.id);

    bus.emit("agent.completed", {
      uid,
      agentId: agentConfig.id,
      sessionId: session.id,
      content: revisedContent,
      tokenUsage: totalUsage,
      toolResults: allToolResults.map((r) => ({
        name: r.name,
        durationMs: r.durationMs,
        error: r.error,
      })),
      traceId,
      timestamp: Date.now(),
    });

    // Emit latency metrics event (#5)
    bus.emit("agent.metrics", {
      uid,
      agentId: agentConfig.id,
      sessionId: session.id,
      traceId,
      contextAssemblyMs,
      inferenceMs,
      toolExecutionMs,
      totalTokens: totalUsage.total,
      round,
      timestamp: Date.now(),
    });

    // Compaction window forecasting (#6)
    const currentMsgTokens = allMessages.reduce((s, m) => s + (m.tokenEstimate ?? Math.ceil(m.content.length / 4)), 0);
    const compactionThreshold = agentConfig.model.maxContextTokens * 0.7;
    const avgTokensPerTurn = currentMsgTokens / Math.max(1, Math.floor(allMessages.length / 2));
    const turnsUntilCompaction = Math.floor((compactionThreshold - currentMsgTokens) / Math.max(1, avgTokensPerTurn));
    if (turnsUntilCompaction > 0 && turnsUntilCompaction <= 5) {
      if (!QUIET()) console.log(`${tracePrefix} Compaction forecast: ~${turnsUntilCompaction} turns remaining — pre-saving memories`);
      postTurnAutoSave(uid, userMessage, revisedContent).catch(() => {});
    }

    updatePresence(agentConfig.id, workspaceId ?? uid, "idle");

    // Yield any queued branch events before completing
    while (branchEventQueue.length > 0) {
      yield branchEventQueue.shift()!;
    }

    // Clean up branch event listeners
    unsubBranchCreated();
    unsubBranchSwitched();

    yield {
      type: "completed",
      content: revisedContent,
      sessionId: session.id,
      tokenUsage: totalUsage,
      toolResults: allToolResults.map((r) => ({
        name: r.name,
        durationMs: r.durationMs,
        error: r.error,
      })),
      enrichments: {
        mood: finalMood,
        confidence,
        toneDrift: toneDriftResult,
        goals: goalTitles,
        persona: personaCtx,
      },
    };

    return;
  }

  // Clean up branch event listeners on timeout path
  unsubBranchCreated();
  unsubBranchSwitched();

  // Safety: exhausted tool rounds
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

  yield {
    type: "completed",
    content: fallback,
    sessionId: session.id,
    tokenUsage: totalUsage,
    toolResults: allToolResults.map((r) => ({
      name: r.name,
      durationMs: r.durationMs,
      error: r.error,
    })),
  };
}
