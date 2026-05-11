// ── Delegate Tool Call (Feature 18) ──────────────────────────────────
// Tool that allows an agent to delegate a tool call to another agent
// that has the required permission.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import type { ToolContext } from "./types.js";
import { delegateToolCall, type DelegationRequest } from "../agents/tool-delegation.js";

const DelegateParams = z.object({
  tool_name: z.string().describe("Name of the tool to delegate"),
  tool_args: z.record(z.string(), z.unknown()).describe("Arguments to pass to the tool"),
  target_agent_id: z.string().optional().describe("Specific agent ID to delegate to (auto-resolved if omitted)"),
  reason: z.string().optional().describe("Why this delegation is needed"),
});

registerTool({
  name: "delegate_tool_call",
  description:
    "Delegate a tool call to another agent that has the required permission. " +
    "Use when you need a tool you don't have access to. The system will find " +
    "the best agent with the required tool and execute it on your behalf.",
  parameters: DelegateParams,
  async execute(params: z.infer<typeof DelegateParams>, ctx: ToolContext) {
    const request: DelegationRequest = {
      requestId: randomUUID(),
      fromAgentId: ctx.agentId,
      fromRole: (ctx.metadata?.role as string) ?? "unknown",
      toAgentId: params.target_agent_id,
      toolName: params.tool_name,
      toolArgs: params.tool_args,
    };

    const result = await delegateToolCall(request, ctx);

    if (!result.success) {
      return {
        error: result.error ?? "Delegation failed",
        delegatedTo: result.delegatedTo,
        durationMs: result.durationMs,
      };
    }

    // Parse the tool result content back
    try {
      return {
        result: JSON.parse(result.result!.content),
        delegatedTo: result.delegatedTo,
        durationMs: result.durationMs,
      };
    } catch {
      return {
        result: result.result!.content,
        delegatedTo: result.delegatedTo,
        durationMs: result.durationMs,
      };
    }
  },
});
