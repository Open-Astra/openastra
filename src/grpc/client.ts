// ── gRPC Agent Client ────────────────────────────────────────────────
// Typed client for agent-to-agent calls over gRPC.
// Used when USE_GRPC_SPAWN=true to route spawn calls over the network
// instead of direct in-process function calls.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Proto Loading ────────────────────────────────────────────────────

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
const AgentServiceClient = astraPackage.AgentService as any;

// ── Request/Response Types ───────────────────────────────────────────

export interface GrpcAgentRequest {
  uid: string;
  message: string;
  agentId: string;
  surface?: string;
  surfaceId?: string;
  sessionId?: string;
}

export interface GrpcAgentResponse {
  content: string;
  sessionId: string;
  toolResults: Array<{
    name: string;
    durationMs: number;
    error: string;
  }>;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface GrpcStreamEvent {
  type: string;
  content: string;
  sessionId: string;
  toolName: string;
  toolDurationMs: number;
  error: string;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface GrpcSpawnRequest {
  uid: string;
  parentAgentId: string;
  targetAgentId: string;
  task: string;
  depth?: number;
}

export interface GrpcSpawnResponse {
  taskId: string;
  targetAgentId: string;
  content: string;
  success: boolean;
  durationMs: number;
  sessionId: string;
  error: string;
}

export interface GrpcHealthResponse {
  status: string;
  timestamp: number;
}

// ── Client Interface ─────────────────────────────────────────────────

export interface GrpcAgentClient {
  runAgentLoop(request: GrpcAgentRequest): Promise<GrpcAgentResponse>;
  runAgentLoopStream(request: GrpcAgentRequest): AsyncIterable<GrpcStreamEvent>;
  spawnAgent(request: GrpcSpawnRequest): Promise<GrpcSpawnResponse>;
  healthCheck(): Promise<GrpcHealthResponse>;
  close(): void;
}

// ── Client Factory ───────────────────────────────────────────────────

export function createGrpcAgentClient(address: string): GrpcAgentClient {
  const client = new AgentServiceClient(
    address,
    grpc.credentials.createInsecure(),
  );

  return {
    runAgentLoop(request: GrpcAgentRequest): Promise<GrpcAgentResponse> {
      return new Promise((resolve, reject) => {
        client.runAgentLoop(request, (err: grpc.ServiceError | null, response: GrpcAgentResponse) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    },

    runAgentLoopStream(request: GrpcAgentRequest): AsyncIterable<GrpcStreamEvent> {
      const stream = client.runAgentLoopStream(request);

      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<GrpcStreamEvent>> {
              return new Promise((resolve, reject) => {
                stream.once("data", (data: GrpcStreamEvent) => {
                  resolve({ value: data, done: false });
                });
                stream.once("end", () => {
                  resolve({ value: undefined as unknown as GrpcStreamEvent, done: true });
                });
                stream.once("error", (err: Error) => {
                  reject(err);
                });
              });
            },
          };
        },
      };
    },

    spawnAgent(request: GrpcSpawnRequest): Promise<GrpcSpawnResponse> {
      return new Promise((resolve, reject) => {
        client.spawnAgent(request, (err: grpc.ServiceError | null, response: GrpcSpawnResponse) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    },

    healthCheck(): Promise<GrpcHealthResponse> {
      return new Promise((resolve, reject) => {
        client.healthCheck({}, (err: grpc.ServiceError | null, response: GrpcHealthResponse) => {
          if (err) return reject(err);
          resolve(response);
        });
      });
    },

    close() {
      client.close();
    },
  };
}
