import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { jwtAuth } from "../middleware/auth.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { createInferenceClient } from "../../inference/factory.js";
import type { ChatMessage } from "../../inference/types.js";
import type { AgentConfig } from "../../agents/types.js";
import type { InferenceClient } from "../../inference/types.js";
import type { SessionSurface } from "../../sessions/types.js";
import { runAgentLoopStream } from "../../agents/loop-stream.js";
import { resetSession } from "../../sessions/store.js";
import { createLogger } from "../../utils/logger.js";
import { isPlatformAdmin } from "../middleware/platform-admin.js";
import { checkModelEndpoint } from "../middleware/model-endpoint.js";
import { authorizeAgentRun } from "../agent-access.js";
import { trackTokenUsage } from "../../billing/tracker.js";
import {
  WS_MAX_PAYLOAD_BYTES,
  isAllowedWsOrigin,
  extractWsToken,
  authenticateWs,
  closeOnTokenExpiry,
} from "../ws-auth.js";

// ── Playground Router ──────────────────────────────────────────────────
// Two modes:
//   1. POST /playground/chat — stateless inference (no session, no memory, no tools)
//   2. WebSocket /playground/ws/:agentId — interactive agent testing with sessions

const log = createLogger("playground");

// In-memory sliding-window rate limiter: 10 req/min per uid
const playgroundRateLimits = new Map<string, number[]>();
const PLAYGROUND_LIMIT = 10;
const PLAYGROUND_WINDOW_MS = 60_000;

function checkPlaygroundRate(uid: string): boolean {
  const now = Date.now();
  const windowStart = now - PLAYGROUND_WINDOW_MS;
  const timestamps = (playgroundRateLimits.get(uid) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= PLAYGROUND_LIMIT) {
    return false;
  }

  timestamps.push(now);
  playgroundRateLimits.set(uid, timestamps);
  return true;
}

const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable(),
  tool_call_id: z.string().optional(),
});

const ProviderEnum = z.enum([
  "grok", "groq", "openai", "gemini", "claude", "vllm", "ollama",
  "openrouter", "mistral", "bedrock",
]);

const PlaygroundChatBody = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  model: z.object({
    provider: ProviderEnum,
    modelId: z.string().min(1),
    endpoint: z.string().url().optional(),
  }),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
});

// WebSocket message schemas
const WsMessageSchema = z.union([
  z.object({
    type: z.literal("message").optional().default("message"),
    message: z.string().min(1).max(10000),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  }),
  z.object({
    type: z.literal("reset"),
  }),
]);

export function createPlaygroundRouter(): Router {
  const router = Router();
  router.use(jwtAuth());

  // POST /playground/chat — stateless inference
  router.post("/chat", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;

    if (!checkPlaygroundRate(uid)) {
      res.status(429).json({
        error: "Rate limit exceeded",
        message: `Playground allows ${PLAYGROUND_LIMIT} requests per minute`,
      });
      return;
    }

    const parsed = PlaygroundChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { messages, model, temperature, maxTokens } = parsed.data;

    // A caller-supplied endpoint would receive the platform's provider key
    // (keyed providers) or turn the gateway into an SSRF proxy (ollama/vllm).
    const endpointError = await checkModelEndpoint(model, { isAdmin: isPlatformAdmin(req) });
    if (endpointError) {
      res.status(403).json({ error: endpointError });
      return;
    }

    try {
      const client = createInferenceClient({
        provider: model.provider,
        modelId: model.modelId,
        endpoint: model.endpoint,
        maxContextTokens: 128_000,
        maxOutputTokens: 4096,
        temperature: temperature ?? 0.7,
      });

      const response = await client.chat({
        messages: messages as ChatMessage[],
        temperature,
        maxTokens,
      });

      // Playground inference runs on platform keys — meter it like any other turn
      if (response.usage) {
        trackTokenUsage(
          uid,
          "playground",
          {
            prompt: response.usage.promptTokens,
            completion: response.usage.completionTokens,
            total: response.usage.totalTokens,
            cached: response.usage.cachedTokens,
          },
          "playground",
        ).catch((err: unknown) => log.error("Token tracking failed:", err));
      }

      res.json({
        content: response.content,
        finishReason: response.finishReason,
        usage: response.usage,
        model: { provider: model.provider, modelId: model.modelId },
      });
    } catch (err) {
      // Provider errors can echo URLs, headers or internal hostnames — log
      // them, never return them.
      log.error("Chat error:", err);
      res.status(502).json({ error: "Inference failed" });
    }
  });

  return router;
}

// ── Playground WebSocket ────────────────────────────────────────────
// Mount on the HTTP server for WebSocket upgrade at /playground/ws/:agentId

export function initPlaygroundWebSocket(
  server: HttpServer,
  resolveClient: (config: AgentConfig) => InferenceClient,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    handleProtocols: (protocols: Set<string>) => {
      for (const p of protocols) if (p.startsWith("bearer.")) return p;
      return false;
    },
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/playground\/ws\/([^/]+)$/);

    if (!match) return; // Not a playground WS request — let other handlers deal with it

    const agentId = match[1]!;

    // Cross-site WebSocket hijacking guard
    if (!isAllowedWsOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = extractWsToken(req);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const workspaceId = url.searchParams.get("workspaceId") || null;

    authenticateWs(req, token)
      .then(async ({ uid, expiresAt }) => {
        // Same checks as POST /agent/chat: membership, agent ownership
        // (global agents only without a workspace), model policy, budget.
        const decision = await authorizeAgentRun(uid, agentId, workspaceId);
        if (!decision.ok) {
          socket.write(`HTTP/1.1 ${decision.status === 404 ? "404 Not Found" : "403 Forbidden"}\r\n\r\n`);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          closeOnTokenExpiry(ws, expiresAt);
          wss.emit("connection", ws, req, { uid, agentId, workspaceId, agentConfig: decision.config });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
      });
  });

  wss.on("connection", (
    ws: WebSocket,
    _req: unknown,
    meta: { uid: string; agentId: string; workspaceId: string | null; agentConfig: AgentConfig },
  ) => {
    const { uid, agentId, workspaceId } = meta;
    const playgroundSessionId = `playground-${randomUUID().slice(0, 8)}`;

    log.dim(`Playground WS connected: uid=${uid} agent=${agentId} session=${playgroundSessionId}`);

    // Agent config was resolved and authorized during the upgrade
    let agentConfig: AgentConfig = meta.agentConfig;
    let inferenceClient = resolveClient(agentConfig);
    let busy = false;
    let currentSessionSuffix = playgroundSessionId;

    const sessionKey = () => ({
      uid,
      surface: "chat" as SessionSurface,
      surfaceId: currentSessionSuffix,
    });

    ws.send(JSON.stringify({ type: "connected", agentId, sessionId: currentSessionSuffix }));

    ws.on("message", async (data) => {
      if (!checkPlaygroundRate(uid)) {
        ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
        return;
      }

      let rawMsg: unknown;
      try {
        rawMsg = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      const parsed = WsMessageSchema.safeParse(rawMsg);
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        return;
      }

      const msg = parsed.data;

      if (msg.type === "reset") {
        // Reset session
        const newSuffix = `playground-${randomUUID().slice(0, 8)}`;
        resetSession(sessionKey(), agentConfig)
          .then(() => {
            currentSessionSuffix = newSuffix;
            ws.send(JSON.stringify({ type: "session_reset", sessionId: newSuffix }));
          })
          .catch((err: unknown) => {
            ws.send(JSON.stringify({ type: "error", message: `Reset failed: ${err instanceof Error ? err.message : String(err)}` }));
          });
        return;
      }

      // One turn at a time per connection
      if (busy) {
        ws.send(JSON.stringify({ type: "error", message: "A response is already in progress" }));
        return;
      }

      // Re-authorize every turn: membership, grants and budget can change
      // while the socket stays open.
      const decision = await authorizeAgentRun(uid, agentId, workspaceId);
      if (!decision.ok) {
        ws.send(JSON.stringify({ type: "error", message: decision.message }));
        if (decision.status !== 429) ws.close(4003, "Not authorized");
        return;
      }
      if (decision.config !== agentConfig) {
        agentConfig = decision.config;
        inferenceClient = resolveClient(agentConfig);
      }

      // Override session suffix if provided (namespaced under this uid's
      // playground sessions)
      if (msg.sessionId) {
        currentSessionSuffix = `playground-${msg.sessionId.replace(/^playground-/, "")}`;
      }

      // Stream agent response
      const stream = runAgentLoopStream(
        uid,
        msg.message,
        agentConfig,
        inferenceClient,
        sessionKey(),
        undefined, // signal
        workspaceId ?? undefined,
      );

      busy = true;
      (async () => {
        try {
          for await (const event of stream) {
            if (event.type === "completed" && event.tokenUsage) {
              trackTokenUsage(uid, agentId, event.tokenUsage, event.sessionId, workspaceId ?? undefined)
                .catch(() => {});
            }
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(JSON.stringify(event));
          }
        } catch (err) {
          log.error("Playground stream failed:", err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "Agent run failed" }));
          }
        } finally {
          busy = false;
        }
      })().catch((err: unknown) => {
        log.error("Playground stream error:", err);
      });
    });

    ws.on("close", () => {
      log.dim(`Playground WS disconnected: uid=${uid} session=${playgroundSessionId}`);
    });
  });

  log.active("Playground WebSocket initialized", "/playground/ws/:agentId");
}
