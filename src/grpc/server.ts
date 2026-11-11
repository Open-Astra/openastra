// ── gRPC Agent Server ────────────────────────────────────────────────
// Exposes the agent loop, streaming loop, spawn, and health check
// over gRPC for internal service-to-service communication.
// Opt-in: only started when GRPC_ENABLED=true.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { runAgentLoop } from "../agents/loop.js";
import { spawnAgent } from "../agents/spawn.js";
import { getAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import type { SessionSurface } from "../sessions/types.js";
import type { AgentId } from "../agents/types.js";

// ── Proto Loading ────────────────────────────────────────────────────
// Works in both tsx (src/) and compiled (dist/) because proto is
// resolved relative to __dirname at runtime.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, "protos", "agent.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>;
const astraPackage = proto.astra as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AgentServiceDef = astraPackage.AgentService as any;

// ── Proto Message Interfaces ─────────────────────────────────────────

interface ProtoAgentRequest {
  uid: string;
  message: string;
  agentId: string;
  surface: string;
  surfaceId: string;
  sessionId: string;
}

interface ProtoSpawnRequest {
  uid: string;
  parentAgentId: string;
  targetAgentId: string;
  task: string;
  depth: number;
}

// ── Streaming Loop (Optional) ────────────────────────────────────────
// The streaming agent loop may not be available in all deployments.
// We dynamically import it so the gRPC server can start without it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamLoopFn = (...args: any[]) => AsyncGenerator<any>;
let _runAgentLoopStream: StreamLoopFn | null = null;
let _streamLoopChecked = false;

async function getRunAgentLoopStream(): Promise<StreamLoopFn | null> {
  if (_streamLoopChecked) return _runAgentLoopStream;
  _streamLoopChecked = true;

  try {
    // Use a variable to prevent TypeScript from statically resolving
    // this module — it may not exist in all deployments.
    const streamModulePath = "../agents/loop-stream.js";
    const mod = await import(/* @vite-ignore */ streamModulePath);
    _runAgentLoopStream = mod.runAgentLoopStream;
  } catch {
    console.log("[grpc] Streaming agent loop not available — RunAgentLoopStream RPC will return UNIMPLEMENTED");
  }

  return _runAgentLoopStream;
}

// ── Authentication ───────────────────────────────────────────────────
// Every RPC except HealthCheck must carry the shared service key in the
// `x-api-key` metadata entry (GRPC_API_KEY, falling back to
// INTERNAL_API_KEY). The request message's `uid` is trusted only because
// the caller has proven it is an internal service — without this check any
// client that can reach the port could act as any user. With no key
// configured every call is refused (fail closed).

function expectedServiceKey(): string | undefined {
  return process.env.GRPC_API_KEY || process.env.INTERNAL_API_KEY || undefined;
}

function isAuthorized(metadata: grpc.Metadata): boolean {
  const expected = expectedServiceKey();
  if (!expected) return false;
  const provided = metadata.get("x-api-key")[0];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const UNAUTHENTICATED = {
  code: grpc.status.UNAUTHENTICATED,
  message: "Missing or invalid x-api-key metadata",
};

function validRequestFields(...fields: unknown[]): boolean {
  return fields.every((f) => typeof f === "string" && f.length > 0 && f.length <= 100_000);
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleRunAgentLoop(
  call: grpc.ServerUnaryCall<ProtoAgentRequest, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) {
  if (!isAuthorized(call.metadata)) {
    callback(UNAUTHENTICATED);
    return;
  }

  try {
    const req = call.request;
    if (!validRequestFields(req.uid, req.agentId, req.message)) {
      callback({ code: grpc.status.INVALID_ARGUMENT, message: "uid, agentId and message are required" });
      return;
    }

    const agentConfig = getAgentConfig(req.agentId as AgentId);
    const inferenceClient = getInferenceClientForAgent(agentConfig);

    const sessionKey = {
      uid: req.uid,
      surface: (req.surface || "chat") as SessionSurface,
      surfaceId: req.surfaceId || "main",
    };

    const result = await runAgentLoop(
      req.uid,
      req.message,
      agentConfig,
      inferenceClient,
      sessionKey,
    );

    callback(null, {
      content: result.content,
      sessionId: result.sessionId,
      toolResults: result.toolResults.map((tr) => ({
        name: tr.name,
        durationMs: tr.durationMs,
        error: tr.error || "",
      })),
      tokenUsage: {
        prompt: result.tokenUsage.prompt,
        completion: result.tokenUsage.completion,
        total: result.tokenUsage.total,
      },
    });
  } catch (err) {
    // Internal error text can carry provider URLs / SQL — log, don't return
    console.error("[grpc] runAgentLoop failed:", err);
    const notFound = err instanceof Error && err.message.startsWith("Unknown agent");
    callback({
      code: notFound ? grpc.status.NOT_FOUND : grpc.status.INTERNAL,
      message: notFound ? "Unknown agent" : "Agent run failed",
    });
  }
}

function handleRunAgentLoopStream(
  call: grpc.ServerWritableStream<ProtoAgentRequest, unknown>,
) {
  if (!isAuthorized(call.metadata)) {
    call.destroy(Object.assign(new Error(UNAUTHENTICATED.message), { code: UNAUTHENTICATED.code }));
    return;
  }

  const req = call.request;
  if (!validRequestFields(req.uid, req.agentId, req.message)) {
    call.destroy(Object.assign(new Error("uid, agentId and message are required"), {
      code: grpc.status.INVALID_ARGUMENT,
    }));
    return;
  }

  (async () => {
    try {
      const streamFn = await getRunAgentLoopStream();

      if (!streamFn) {
        call.destroy({
          name: "UNIMPLEMENTED",
          message: "Streaming agent loop is not available in this deployment",
          code: grpc.status.UNIMPLEMENTED,
        } as Error);
        return;
      }

      const agentConfig = getAgentConfig(req.agentId as AgentId);
      const inferenceClient = getInferenceClientForAgent(agentConfig);

      const sessionKey = {
        uid: req.uid,
        surface: (req.surface || "chat") as SessionSurface,
        surfaceId: req.surfaceId || "main",
      };

      const stream = streamFn(
        req.uid,
        req.message,
        agentConfig,
        inferenceClient,
        sessionKey,
      );

      for await (const event of stream) {
        // Map internal stream events to proto format
        const protoEvent: Record<string, unknown> = {
          type: event.type,
          content: "",
          sessionId: "",
          toolName: "",
          toolDurationMs: 0,
          error: "",
        };

        switch (event.type) {
          case "session_resolved":
            protoEvent.sessionId = event.sessionId;
            break;
          case "stream_delta":
            protoEvent.content = event.content;
            break;
          case "tool_call_start":
          case "tool_call_complete":
            protoEvent.toolName = event.name;
            break;
          case "tool_result":
            protoEvent.toolName = event.name;
            protoEvent.content = event.content;
            protoEvent.toolDurationMs = event.durationMs;
            if (event.error) protoEvent.error = event.error;
            break;
          case "completed":
            protoEvent.content = event.content;
            protoEvent.sessionId = event.sessionId;
            if (event.tokenUsage) {
              protoEvent.tokenUsage = {
                prompt: event.tokenUsage.prompt,
                completion: event.tokenUsage.completion,
                total: event.tokenUsage.total,
              };
            }
            break;
          case "error":
            protoEvent.error = event.message;
            break;
        }

        call.write(protoEvent);
      }

      call.end();
    } catch (err) {
      console.error("[grpc] runAgentLoopStream failed:", err);
      call.destroy(Object.assign(new Error("Agent run failed"), { code: grpc.status.INTERNAL }));
    }
  })();
}

async function handleSpawnAgent(
  call: grpc.ServerUnaryCall<ProtoSpawnRequest, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) {
  if (!isAuthorized(call.metadata)) {
    callback(UNAUTHENTICATED);
    return;
  }

  try {
    const req = call.request;
    if (!validRequestFields(req.uid, req.parentAgentId, req.targetAgentId, req.task)) {
      callback({ code: grpc.status.INVALID_ARGUMENT, message: "uid, parentAgentId, targetAgentId and task are required" });
      return;
    }

    const parentConfig = getAgentConfig(req.parentAgentId as AgentId);
    const targetConfig = getAgentConfig(req.targetAgentId as AgentId);
    const inferenceClient = getInferenceClientForAgent(targetConfig);

    const result = await spawnAgent(
      parentConfig,
      req.targetAgentId as AgentId,
      req.task,
      req.uid,
      inferenceClient,
      req.depth || 1,
    );

    callback(null, {
      taskId: result.taskId,
      targetAgentId: result.targetAgentId,
      content: result.content,
      success: result.success,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      error: "",
    });
  } catch (err) {
    console.error("[grpc] spawnAgent failed:", err);
    callback(null, {
      taskId: "",
      targetAgentId: "",
      content: "",
      success: false,
      durationMs: 0,
      sessionId: "",
      error: "Spawn failed",
    });
  }
}

function handleHealthCheck(
  _call: grpc.ServerUnaryCall<Record<string, never>, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) {
  callback(null, {
    status: "ok",
    timestamp: Date.now(),
  });
}

// ── TLS / mTLS Credentials ───────────────────────────────────────────

/**
 * Build server credentials based on environment variables.
 *
 * When GRPC_TLS_CERT, GRPC_TLS_KEY, and GRPC_TLS_CA are all set, mutual
 * TLS is enabled (requireClientCerts = true).
 *
 * Plaintext is never a silent fallback:
 *   • a certificate that fails to load is a startup error
 *   • without TLS the server only starts outside production, or when the
 *     operator sets GRPC_ALLOW_INSECURE=true (e.g. a service mesh already
 *     provides transport security) — and then binds to loopback unless
 *     GRPC_BIND_HOST says otherwise.
 */
function buildServerCredentials(): { credentials: grpc.ServerCredentials; secure: boolean } {
  const certPath = process.env.GRPC_TLS_CERT;
  const keyPath = process.env.GRPC_TLS_KEY;
  const caPath = process.env.GRPC_TLS_CA;

  if (certPath && keyPath && caPath) {
    // Let read errors propagate — refusing to start beats serving plaintext
    const caCert = readFileSync(caPath);
    const certChain = readFileSync(certPath);
    const privateKey = readFileSync(keyPath);

    console.log("[grpc] mTLS enabled — mutual certificate verification active");
    return {
      credentials: grpc.ServerCredentials.createSsl(
        caCert,
        [{ private_key: privateKey, cert_chain: certChain }],
        true, // requireClientCerts — enforces mTLS
      ),
      secure: true,
    };
  }

  const missing = [
    !certPath && "GRPC_TLS_CERT",
    !keyPath && "GRPC_TLS_KEY",
    !caPath && "GRPC_TLS_CA",
  ].filter(Boolean);

  const insecureAllowed =
    process.env.GRPC_ALLOW_INSECURE === "true" || process.env.NODE_ENV !== "production";
  if (!insecureAllowed) {
    throw new Error(
      `[grpc] TLS not configured (missing: ${missing.join(", ")}). ` +
        "Refusing to start a plaintext gRPC server in production — configure mTLS " +
        "or set GRPC_ALLOW_INSECURE=true if transport security is provided elsewhere.",
    );
  }

  console.warn(`[grpc] TLS not configured (missing: ${missing.join(", ")}) — using insecure credentials`);
  return { credentials: grpc.ServerCredentials.createInsecure(), secure: false };
}

// ── Server Lifecycle ─────────────────────────────────────────────────

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();

  server.addService(AgentServiceDef.service, {
    runAgentLoop: handleRunAgentLoop,
    runAgentLoopStream: handleRunAgentLoopStream,
    spawnAgent: handleSpawnAgent,
    healthCheck: handleHealthCheck,
  });

  if (!expectedServiceKey()) {
    throw new Error("[grpc] GRPC_API_KEY (or INTERNAL_API_KEY) must be set — the gRPC server requires an API key");
  }

  const { credentials, secure } = buildServerCredentials();

  // Plaintext servers stay on loopback unless the operator opts out
  const host = process.env.GRPC_BIND_HOST || (secure ? "0.0.0.0" : "127.0.0.1");

  server.bindAsync(
    `${host}:${port}`,
    credentials,
    (err, boundPort) => {
      if (err) {
        console.error("[grpc] Failed to bind:", err);
        return;
      }
      console.log(`[grpc] Server bound on ${host}:${boundPort}`);
    },
  );

  return server;
}

export function stopGrpcServer(server: grpc.Server): void {
  server.tryShutdown((err) => {
    if (err) {
      console.error("[grpc] Graceful shutdown failed, forcing:", err);
      server.forceShutdown();
    } else {
      console.log("[grpc] Server stopped gracefully");
    }
  });
}
