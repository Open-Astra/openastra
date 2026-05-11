// ── gRPC Agent Server ────────────────────────────────────────────────
// Exposes the agent loop, streaming loop, spawn, and health check
// over gRPC for internal service-to-service communication.
// Opt-in: only started when GRPC_ENABLED=true.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
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

// ── Handlers ─────────────────────────────────────────────────────────

async function handleRunAgentLoop(
  call: grpc.ServerUnaryCall<ProtoAgentRequest, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) {
  try {
    const req = call.request;

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
    const message = err instanceof Error ? err.message : String(err);
    callback({
      code: grpc.status.INTERNAL,
      message,
    });
  }
}

function handleRunAgentLoopStream(
  call: grpc.ServerWritableStream<ProtoAgentRequest, unknown>,
) {
  const req = call.request;

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
      const message = err instanceof Error ? err.message : String(err);
      call.destroy(new Error(message));
    }
  })();
}

async function handleSpawnAgent(
  call: grpc.ServerUnaryCall<ProtoSpawnRequest, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) {
  try {
    const req = call.request;

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
    const message = err instanceof Error ? err.message : String(err);
    callback(null, {
      taskId: "",
      targetAgentId: "",
      content: "",
      success: false,
      durationMs: 0,
      sessionId: "",
      error: message,
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
 * TLS is enabled (requireClientCerts = true).  If any variable is absent
 * the server falls back to insecure plaintext and logs a warning.
 */
function buildServerCredentials(): grpc.ServerCredentials {
  const certPath = process.env.GRPC_TLS_CERT;
  const keyPath = process.env.GRPC_TLS_KEY;
  const caPath = process.env.GRPC_TLS_CA;

  if (certPath && keyPath && caPath) {
    try {
      const caCert = readFileSync(caPath);
      const certChain = readFileSync(certPath);
      const privateKey = readFileSync(keyPath);

      console.log("[grpc] mTLS enabled — mutual certificate verification active");
      return grpc.ServerCredentials.createSsl(
        caCert,
        [{ private_key: privateKey, cert_chain: certChain }],
        true, // requireClientCerts — enforces mTLS
      );
    } catch (err) {
      console.error("[grpc] Failed to load TLS certificates, falling back to insecure:", err);
    }
  } else {
    const missing = [
      !certPath && "GRPC_TLS_CERT",
      !keyPath && "GRPC_TLS_KEY",
      !caPath && "GRPC_TLS_CA",
    ].filter(Boolean);
    if (missing.length > 0) {
      console.warn(`[grpc] TLS not configured (missing: ${missing.join(", ")}) — using insecure credentials`);
    }
  }

  return grpc.ServerCredentials.createInsecure();
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

  const credentials = buildServerCredentials();

  server.bindAsync(
    `0.0.0.0:${port}`,
    credentials,
    (err, boundPort) => {
      if (err) {
        console.error("[grpc] Failed to bind:", err);
        return;
      }
      console.log(`[grpc] Server bound on port ${boundPort}`);
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
