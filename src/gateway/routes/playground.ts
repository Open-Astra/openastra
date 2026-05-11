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
import { getAgentConfig } from "../../config/agents.js";
import { runAgentLoopStream } from "../../agents/loop-stream.js";
import { resetSession } from "../../sessions/store.js";
import { verifyAccessToken } from "../../auth/jwt.js";
import { createLogger } from "../../utils/logger.js";

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
    sessionId: z.string().optional(),
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

      res.json({
        content: response.content,
        finishReason: response.finishReason,
        usage: response.usage,
        model: { provider: model.provider, modelId: model.modelId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[playground] Chat error:", err);
      res.status(500).json({ error: "Inference failed", detail: message });
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
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/playground\/ws\/([^/]+)$/);

    if (!match) return; // Not a playground WS request — let other handlers deal with it

    const agentId = match[1];
    const token = url.searchParams.get("token");

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    verifyAccessToken(token)
      .then(({ uid }) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req, { uid, agentId });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
      });
  });

  wss.on("connection", (ws: WebSocket, _req: unknown, meta: { uid: string; agentId: string }) => {
    const { uid, agentId } = meta;
    const playgroundSessionId = `playground-${randomUUID().slice(0, 8)}`;

    log.dim(`Playground WS connected: uid=${uid} agent=${agentId} session=${playgroundSessionId}`);

    // Resolve agent config
    let agentConfig: AgentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: `Agent "${agentId}" not found` }));
      ws.close(4004, "Agent not found");
      return;
    }

    const inferenceClient = resolveClient(agentConfig);
    let currentSessionSuffix = playgroundSessionId;

    const sessionKey = () => ({
      uid,
      surface: "chat" as SessionSurface,
      surfaceId: currentSessionSuffix,
    });

    ws.send(JSON.stringify({ type: "connected", agentId, sessionId: currentSessionSuffix }));

    ws.on("message", (data) => {
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

      // Override session suffix if provided
      if (msg.sessionId) {
        currentSessionSuffix = msg.sessionId;
      }

      // Stream agent response
      const stream = runAgentLoopStream(
        uid,
        msg.message,
        agentConfig,
        inferenceClient,
        sessionKey(),
        undefined, // signal
        undefined, // workspaceId
      );

      (async () => {
        try {
          for await (const event of stream) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(JSON.stringify(event));
          }
        } catch (err) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
          }
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
