import { Router } from "express";
import { z } from "zod";
import type { BudgetAwareRequest } from "../middleware/token-budget.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { runAgentLoop } from "../../agents/loop.js";
import { runAgentLoopStream } from "../../agents/loop-stream.js";
import { resetSession } from "../../sessions/store.js";
import { getAgentConfig } from "../../config/agents.js";
import { resolveAgentForWorkspace } from "../../agents/config-store.js";
import type { AgentConfig } from "../../agents/types.js";
import type { InferenceClient } from "../../inference/types.js";
import type { SessionSurface } from "../../sessions/types.js";
import { trackTokenUsage } from "../../billing/tracker.js";
import { handleCommand } from "../commands.js";
import { getPresence } from "../presence.js";
import { detectPromptInjection } from "../../security/prompt-injection.js";
import { loadEnv } from "../../config/env.js";
import { getEventBus } from "../../events/index.js";
import { isBlockedUrl } from "../../utils/ssrf-guard.js";
import type { MessageInput } from "../../agents/message-input.js";

// ── Request Validation ──────────────────────────────────────────────

const ChatRequestBody = z.object({
  message: z.string().min(1).max(10000),
  images: z.array(z.string().url()).max(5).optional(), // image URLs for vision models
  agentId: z.string().default("chad"),
  surface: z.enum(["chat", "prop", "group"]).default("chat"),
  surfaceId: z.string().default("main"),
  webhookUrl: z.string().url().optional(), // session-scoped output webhook (28)
});

const ResetRequestBody = z.object({
  agentId: z.string().default("chad"),
  surface: z.enum(["chat", "prop", "group"]).default("chat"),
  surfaceId: z.string().default("main"),
});

// ── Idempotency Store (in-memory) ───────────────────────────────────
// Prevents duplicate processing when clients retry on timeout.

const idempotencyStore = new Map<string, { response: unknown; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore) {
    if (now > entry.expiresAt) idempotencyStore.delete(key);
  }
}, 60_000).unref();

// ── Chat Router Factory ─────────────────────────────────────────────

export function createChatRouter(resolveClient: (config: AgentConfig) => InferenceClient): Router {
  const router = Router();

  // POST /agent/chat — send a message to the agent
  router.post("/chat", async (req, res) => {
    const { uid } = req as BudgetAwareRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    const parsed = ChatRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { message, images, agentId, surface, surfaceId, webhookUrl } = parsed.data;

    if (webhookUrl && await isBlockedUrl(webhookUrl)) {
      res.status(400).json({ error: "webhookUrl targets a restricted internal address" });
      return;
    }

    // Build multimodal input when images are provided
    const messageInput: string | MessageInput = images?.length
      ? [
          { type: "text" as const, text: message },
          ...images.map((url) => ({ type: "image_url" as const, url })),
        ]
      : message;

    // Prompt injection detection
    const injectionScan = detectPromptInjection(message);
    if (injectionScan.detected) {
      const env = loadEnv();
      getEventBus().emit("security.prompt_injection_detected" as any, {
        uid, agentId, severity: injectionScan.severity, patterns: injectionScan.patterns, timestamp: Date.now(),
      });
      if (env.promptInjectionPolicy === "block") {
        res.status(400).json({ error: "Message contains potentially unsafe content" });
        return;
      }
    }

    // Idempotency check
    const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const cached = idempotencyStore.get(`${uid}:${idempotencyKey}`);
      if (cached) {
        res.json(cached.response);
        return;
      }
    }

    // Check for slash commands first
    const sessionKey = { uid, surface: surface as SessionSurface, surfaceId };
    const cmdResult = await handleCommand(message, uid, agentId, sessionKey);
    if (cmdResult) {
      const response = { content: cmdResult.content, sessionId: null, toolsUsed: [], usage: null };
      res.json(response);
      return;
    }

    let baseConfig: AgentConfig;
    try {
      baseConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent "${agentId}" not found` });
      return;
    }

    try {
      // Workspace-scoped agent resolution (rec 24):
      // owned → granted → global astra.yml agents → 403
      const resolved = await resolveAgentForWorkspace(agentId, baseConfig, workspaceId);
      if (!resolved) {
        res.status(403).json({ error: `Agent "${agentId}" is not available in this workspace` });
        return;
      }

      let agentConfig = resolved.config;
      const budgetReq = req as BudgetAwareRequest;
      if (budgetReq.budgetDegraded && budgetReq.overrideModel) {
        agentConfig = { ...agentConfig, model: { ...agentConfig.model, modelId: budgetReq.overrideModel } };
      }

      // Per-workspace model restrictions (rec 21)
      if (workspaceId) {
        const { getPool } = await import("../../config/postgres.js");
        const { rows } = await getPool().query<{
          allowed_providers: string[] | null;
          allowed_models: string[] | null;
        }>(
          "SELECT allowed_providers, allowed_models FROM workspaces WHERE id = $1",
          [workspaceId],
        );
        const r = rows[0];
        if (r?.allowed_providers && !r.allowed_providers.includes(agentConfig.model.provider)) {
          res.status(403).json({ error: `Provider "${agentConfig.model.provider}" is not allowed in this workspace` });
          return;
        }
        if (r?.allowed_models && !r.allowed_models.includes(agentConfig.model.modelId)) {
          res.status(403).json({ error: `Model "${agentConfig.model.modelId}" is not allowed in this workspace` });
          return;
        }
      }

      const inferenceClient = resolveClient(agentConfig);

      const response = await runAgentLoop(
        uid,
        messageInput,
        agentConfig,
        inferenceClient,
        sessionKey,
        workspaceId,
        webhookUrl,
      );

      // Fire-and-forget token tracking
      trackTokenUsage(uid, agentId, response.tokenUsage, response.sessionId, workspaceId).catch(
        (err) => console.error("[chat] Token tracking failed:", err),
      );

      const payload = {
        content: response.content,
        sessionId: response.sessionId,
        toolsUsed: response.toolResults.map((r) => ({
          name: r.name,
          durationMs: r.durationMs,
          error: r.error,
        })),
        usage: response.tokenUsage,
      };

      // Cache for idempotency (5 min TTL)
      if (idempotencyKey) {
        idempotencyStore.set(`${uid}:${idempotencyKey}`, {
          response: payload,
          expiresAt: Date.now() + 5 * 60_000,
        });
      }

      res.json(payload);
    } catch (err) {
      console.error("[chat] Agent loop error:", err);
      res.status(500).json({ error: "Agent processing failed" });
    }
  });

  // POST /agent/chat/stream — SSE streaming endpoint
  router.post("/chat/stream", async (req, res) => {
    const { uid } = req as BudgetAwareRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    const parsed = ChatRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { message, images: streamImages, agentId, surface, surfaceId } = parsed.data;
    const sessionKey = { uid, surface: surface as SessionSurface, surfaceId };

    // Build multimodal input when images are provided
    const streamMessageInput: string | MessageInput = streamImages?.length
      ? [
          { type: "text" as const, text: message },
          ...streamImages.map((url) => ({ type: "image_url" as const, url })),
        ]
      : message;

    // Prompt injection detection (streaming)
    const streamInjectionScan = detectPromptInjection(message);
    if (streamInjectionScan.detected) {
      const env = loadEnv();
      getEventBus().emit("security.prompt_injection_detected" as any, {
        uid, agentId, severity: streamInjectionScan.severity, patterns: streamInjectionScan.patterns, timestamp: Date.now(),
      });
      if (env.promptInjectionPolicy === "block") {
        res.status(400).json({ error: "Message contains potentially unsafe content" });
        return;
      }
    }

    // Slash commands return immediately (no streaming needed)
    const cmdResult = await handleCommand(message, uid, agentId, sessionKey);
    if (cmdResult) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ type: "content", content: cmdResult.content })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let streamBaseConfig: AgentConfig;
    try {
      streamBaseConfig = getAgentConfig(agentId);
    } catch {
      sendEvent({ type: "error", error: `Agent "${agentId}" not found` });
      res.end();
      return;
    }

    try {
      const resolved = await resolveAgentForWorkspace(agentId, streamBaseConfig, workspaceId);
      if (!resolved) {
        sendEvent({ type: "error", error: `Agent "${agentId}" is not available in this workspace` });
        res.end();
        return;
      }

      let agentConfig = resolved.config;
      const budgetReq = req as BudgetAwareRequest;
      if (budgetReq.budgetDegraded && budgetReq.overrideModel) {
        agentConfig = { ...agentConfig, model: { ...agentConfig.model, modelId: budgetReq.overrideModel } };
      }
      const inferenceClient = resolveClient(agentConfig);

      const stream = runAgentLoopStream(
        uid,
        streamMessageInput,
        agentConfig,
        inferenceClient,
        sessionKey,
        undefined, // signal
        workspaceId,
      );

      for await (const event of stream) {
        switch (event.type) {
          case "session_resolved":
            sendEvent({ type: "session_resolved", sessionId: event.sessionId, isNew: event.isNew });
            break;
          case "stream_delta":
            sendEvent({ type: "content", content: event.content });
            break;
          case "tool_call_start":
            sendEvent({ type: "tool_call", index: event.index, id: event.id, name: event.name });
            break;
          case "tool_call_complete":
            sendEvent({ type: "tool_call_complete", index: event.index, id: event.id, name: event.name, arguments: event.arguments });
            break;
          case "tool_result":
            sendEvent({ type: "tool_result", name: event.name, durationMs: event.durationMs, error: event.error });
            break;
          case "completed":
            sendEvent({ type: "done", sessionId: event.sessionId, usage: event.tokenUsage });
            trackTokenUsage(uid, agentId, event.tokenUsage, event.sessionId, workspaceId).catch(() => {});
            break;
          case "error":
            sendEvent({ type: "error", message: event.message });
            break;
        }
      }
    } catch (err) {
      console.error("[chat/stream] Agent loop error:", err);
      sendEvent({ type: "error", message: "Agent processing failed" });
    } finally {
      res.end();
    }
  });

  // POST /agent/reset — manually reset the session
  router.post("/reset", async (req, res) => {
    const { uid } = req as BudgetAwareRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId ?? undefined;

    const parsed = ResetRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { agentId, surface, surfaceId } = parsed.data;

    let resetAgentConfig: AgentConfig;
    try {
      resetAgentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Agent "${agentId}" not found` });
      return;
    }

    try {
      const { session } = await resetSession(
        { uid, surface: surface as SessionSurface, surfaceId },
        resetAgentConfig,
        workspaceId,
      );

      res.json({ sessionId: session.id, message: "Session reset" });
    } catch (err) {
      console.error("[reset] Error:", err);
      res.status(500).json({ error: "Session reset failed" });
    }
  });

  // GET /agent/presence — current active agent states for this user
  router.get("/presence", (req, res) => {
    const { uid } = req as BudgetAwareRequest;
    const states = getPresence(uid);
    res.json({ agents: states });
  });

  // GET /agent/health — basic health check
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
