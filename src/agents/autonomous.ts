import type { InferenceClient } from "../inference/types.js";
import type { SessionKey } from "../sessions/types.js";
import type { AgentConfig } from "./types.js";
import { runAgentLoop, type AgentResponse } from "./loop.js";

// ── Autonomous Agent Runner ─────────────────────────────────────────
// Runs an agent autonomously (no user interaction) with a task message.
// The agent config is passed in — no hardcoded agents.

export async function runAutonomousAgent(
  uid: string,
  agentConfig: AgentConfig,
  taskMessage: string,
  inferenceClient: InferenceClient,
  surfaceId?: string,
): Promise<AgentResponse> {
  const sessionKey: SessionKey = {
    uid,
    surface: "chat",
    surfaceId: surfaceId ?? agentConfig.id,
  };

  return runAgentLoop(
    uid,
    taskMessage,
    agentConfig,
    inferenceClient,
    sessionKey,
  );
}
