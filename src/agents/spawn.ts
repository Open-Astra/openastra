import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentId } from "./types.js";
import type { InferenceClient } from "../inference/types.js";
import type { SessionKey } from "../sessions/types.js";
import { getAgentConfig } from "../config/agents.js";
import { runAgentLoop, type AgentResponse } from "./loop.js";
import { logAgentAction } from "./audit.js";
import { getBus, type SpawnTaskMessage, type TaskResultMessage } from "./pubsub.js";

// ── Spawn Errors ───────────────────────────────────────────────────

export class SpawnError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "SPAWN_DISABLED"
      | "TARGET_NOT_ALLOWED"
      | "DEPTH_EXCEEDED"
      | "TARGET_NOT_FOUND"
      | "EXECUTION_FAILED",
  ) {
    super(message);
    this.name = "SpawnError";
  }
}

// ── Spawn Result ───────────────────────────────────────────────────

export interface SpawnResult {
  taskId: string;
  targetAgentId: AgentId;
  content: string;
  success: boolean;
  durationMs: number;
  sessionId: string;
}

// ── Spawn Agent ────────────────────────────────────────────────────
// Validates permissions, creates an isolated session, runs the
// sub-agent loop, and logs everything to audit.
//
// Permission model:
//   1. Parent must have spawn.enabled = true
//   2. Target must be in parent's spawn.allowedTargets
//   3. depth must be < parent's spawn.maxDepth
//   4. Sub-agent tools = intersection of parent's allow list and target's allow list
//      (sub-agents inherit but cannot escalate parent's permissions)

export async function spawnAgent(
  parentConfig: AgentConfig,
  targetAgentId: AgentId,
  task: string,
  uid: string,
  inferenceClient: InferenceClient,
  depth: number = 1,
): Promise<SpawnResult> {
  const taskId = randomUUID();
  const start = Date.now();
  const bus = getBus();

  // ── Validation ───────────────────────────────────────────────────

  if (!parentConfig.spawn.enabled) {
    throw new SpawnError(
      `Agent ${parentConfig.id} does not have spawn enabled`,
      "SPAWN_DISABLED",
    );
  }

  if (!parentConfig.spawn.allowedTargets.includes(targetAgentId)) {
    throw new SpawnError(
      `Agent ${parentConfig.id} is not allowed to spawn ${targetAgentId}`,
      "TARGET_NOT_ALLOWED",
    );
  }

  if (depth >= parentConfig.spawn.maxDepth) {
    throw new SpawnError(
      `Spawn depth ${depth} exceeds max depth ${parentConfig.spawn.maxDepth} for ${parentConfig.id}`,
      "DEPTH_EXCEEDED",
    );
  }

  // Load target agent config
  let targetConfig: AgentConfig;
  try {
    targetConfig = getAgentConfig(targetAgentId);
  } catch {
    throw new SpawnError(
      `Target agent not found: ${targetAgentId}`,
      "TARGET_NOT_FOUND",
    );
  }

  // ── Restrict sub-agent tools ─────────────────────────────────────
  // Sub-agent gets the intersection of parent's and target's allow lists.
  // This ensures a child never escalates beyond the parent's permissions.
  // Skills are also restricted: only skills whose tools are ALL within
  // the parent's effective allow set are inherited.

  const parentAllowSet = new Set(parentConfig.tools.allow);
  const restrictedAllow = targetConfig.tools.allow.filter((tool) =>
    parentAllowSet.has(tool),
  );

  // Filter target skills to prevent privilege escalation via skill tool expansion
  let restrictedSkills: string[] = [];
  try {
    const { getSkillToolNames } = await import("../skills/registry.js");
    restrictedSkills = (targetConfig.skills ?? []).filter((skillId) => {
      const skillTools = getSkillToolNames([skillId]);
      return skillTools.every((tool) => parentAllowSet.has(tool));
    });
  } catch {
    // If skill registry is unavailable, deny all skills for safety
    restrictedSkills = [];
  }

  const restrictedConfig: AgentConfig = {
    ...targetConfig,
    skills: restrictedSkills,
    tools: {
      allow: restrictedAllow,
      deny: targetConfig.tools.deny,
      maxToolCallsPerRound: targetConfig.tools.maxToolCallsPerRound,
    },
  };

  // ── Publish spawn task to bus ────────────────────────────────────

  const spawnMsg: SpawnTaskMessage = {
    type: "spawn_task",
    taskId,
    parentAgentId: parentConfig.id,
    targetAgentId,
    uid,
    task,
    depth,
    timestamp: Date.now(),
  };
  bus.publish("agent-tasks", spawnMsg);

  // ── Audit: log spawn start ───────────────────────────────────────

  await logAgentAction(uid, parentConfig.id, "agent_spawn", {
    taskId,
    targetAgentId,
    task,
    depth,
    restrictedTools: restrictedAllow,
  });

  // ── Create isolated session and run sub-agent ────────────────────

  const sessionKey: SessionKey = {
    uid,
    surface: "prop",
    surfaceId: taskId,
  };

  let response: AgentResponse;
  try {
    console.log(
      `[spawn] ${parentConfig.id} -> ${targetAgentId} | task=${taskId} depth=${depth}`,
    );

    response = await runAgentLoop(
      uid,
      task,
      restrictedConfig,
      inferenceClient,
      sessionKey,
    );
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);

    // Audit: log spawn error
    await logAgentAction(
      uid,
      parentConfig.id,
      "agent_spawn_error",
      { taskId, targetAgentId, error: message, depth },
      durationMs,
    );

    // Publish failure result
    const failResult: TaskResultMessage = {
      type: "task_result",
      taskId,
      parentAgentId: parentConfig.id,
      targetAgentId,
      uid,
      content: `Spawn failed: ${message}`,
      success: false,
      durationMs,
      timestamp: Date.now(),
    };
    bus.publish("agent-results", failResult);

    throw new SpawnError(
      `Spawned agent ${targetAgentId} failed: ${message}`,
      "EXECUTION_FAILED",
    );
  }

  const durationMs = Date.now() - start;

  // ── Audit: log spawn completion ──────────────────────────────────

  await logAgentAction(
    uid,
    parentConfig.id,
    "agent_spawn_complete",
    {
      taskId,
      targetAgentId,
      depth,
      durationMs,
      tokenUsage: response.tokenUsage,
    },
    durationMs,
  );

  // ── Publish result to bus ────────────────────────────────────────

  const resultMsg: TaskResultMessage = {
    type: "task_result",
    taskId,
    parentAgentId: parentConfig.id,
    targetAgentId,
    uid,
    content: response.content,
    success: true,
    durationMs,
    timestamp: Date.now(),
  };
  bus.publish("agent-results", resultMsg);

  console.log(
    `[spawn] ${targetAgentId} completed | task=${taskId} duration=${durationMs}ms`,
  );

  return {
    taskId,
    targetAgentId,
    content: response.content,
    success: true,
    durationMs,
    sessionId: response.sessionId,
  };
}
