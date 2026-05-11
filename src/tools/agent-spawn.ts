import { z } from "zod";
import { registerTool } from "./registry.js";
import { getAgentConfig } from "../config/agents.js";
import { spawnAgent, SpawnError } from "../agents/spawn.js";
import { createInferenceClient } from "../inference/factory.js";
import type { AgentId } from "../agents/types.js";

// ── agent_spawn ────────────────────────────────────────────────────
// Delegates a task to a sub-agent in an isolated session.
// The sub-agent inherits but cannot escalate the parent's tool
// permissions. Spawn depth is capped at 2 (parent -> child -> grandchild).

const AgentSpawnParams = z.object({
  targetAgentId: z
    .string()
    .describe("The ID of the agent to spawn"),
  task: z
    .string()
    .describe("A clear description of the task for the sub-agent to complete"),
});

registerTool({
  name: "agent_spawn",
  description:
    "Delegate a task to a specialized sub-agent. The sub-agent runs in an isolated session with restricted tools and returns its response. Use this to escalate complex analytical requests to a more capable agent.",
  parameters: AgentSpawnParams,

  async execute(params, ctx) {
    const parentConfig = getAgentConfig(ctx.agentId);
    const targetAgentId = params.targetAgentId as AgentId;

    // ── gRPC spawn path ──────────────────────────────────────────────
    // When USE_GRPC_SPAWN=true, route spawn calls over gRPC instead of
    // direct in-process function calls. Useful for distributed deployments.
    if (
      process.env.USE_GRPC_SPAWN === "true" &&
      process.env.GRPC_SPAWN_ADDRESS
    ) {
      try {
        const { createGrpcAgentClient } = await import("../grpc/client.js");
        const client = createGrpcAgentClient(process.env.GRPC_SPAWN_ADDRESS);

        try {
          const result = await client.spawnAgent({
            uid: ctx.uid,
            parentAgentId: ctx.agentId,
            targetAgentId,
            task: params.task,
            depth: 1,
          });

          if (!result.success) {
            return {
              success: false,
              error: result.error || "gRPC spawn failed",
              code: "EXECUTION_FAILED",
            };
          }

          return {
            success: true,
            targetAgentId: result.targetAgentId,
            taskId: result.taskId,
            content: result.content,
            durationMs: result.durationMs,
          };
        } finally {
          client.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `gRPC spawn error: ${message}`,
          code: "EXECUTION_FAILED",
        };
      }
    }

    // ── Direct in-process spawn path (default) ───────────────────────

    // Create an inference client for the target agent's model config
    const targetConfig = getAgentConfig(targetAgentId);
    const inferenceClient = createInferenceClient(targetConfig.model);

    try {
      const result = await spawnAgent(
        parentConfig,
        targetAgentId,
        params.task,
        ctx.uid,
        inferenceClient,
        1, // depth starts at 1 for a direct spawn from a parent agent
      );

      return {
        success: true,
        targetAgentId: result.targetAgentId,
        taskId: result.taskId,
        content: result.content,
        durationMs: result.durationMs,
      };
    } catch (err) {
      if (err instanceof SpawnError) {
        return {
          success: false,
          error: err.message,
          code: err.code,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: message,
        code: "EXECUTION_FAILED",
      };
    }
  },
});
