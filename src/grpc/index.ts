// ── gRPC Module Re-exports ───────────────────────────────────────────

export { startGrpcServer, stopGrpcServer } from "./server.js";
export {
  createGrpcAgentClient,
  type GrpcAgentClient,
  type GrpcAgentRequest,
  type GrpcAgentResponse,
  type GrpcStreamEvent,
  type GrpcSpawnRequest,
  type GrpcSpawnResponse,
  type GrpcHealthResponse,
} from "./client.js";
