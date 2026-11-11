import { z } from "zod";
import { registerTool } from "./registry.js";
import { resolveApproval, getPendingApprovals } from "../agents/approval.js";

// ── approval_resolve ─────────────────────────────────────────────────
// Allows users to approve or deny pending approval requests.
// Lists pending approvals or resolves a specific one.

const ApprovalResolveParams = z.object({
  action: z
    .enum(["list", "approve", "deny"])
    .describe("Action to take: list pending approvals, approve, or deny"),
  requestId: z
    .string()
    .optional()
    .describe("The approval request ID to approve or deny (required for approve/deny)"),
});

registerTool({
  name: "approval_resolve",
  description:
    "Inspect human-in-the-loop approval requests. List the user's pending approvals or deny one. Approving requires a human via the approvals API.",
  parameters: ApprovalResolveParams,

  async execute(params, ctx) {
    if (params.action === "list") {
      const pending = await getPendingApprovals(ctx.uid);
      if (pending.length === 0) {
        return { result: "No pending approval requests." };
      }
      return {
        result: `${pending.length} pending approval(s)`,
        approvals: pending.map((a) => ({
          id: a.id,
          action: a.action,
          agentId: a.agentId,
          details: a.details,
          createdAt: new Date(a.createdAt).toISOString(),
        })),
      };
    }

    if (!params.requestId) {
      return { error: "requestId is required for approve/deny actions" };
    }

    // Approving is a human decision. A model calling this tool would be
    // approving its own (or another session's) request, so approval through
    // the tool surface is refused outright; it must come from an
    // authenticated person via the approvals API or a channel reply.
    if (params.action === "approve") {
      return {
        error:
          "Approvals cannot be granted by an agent. Ask the user to approve the request " +
          "through the approvals API or their channel.",
      };
    }

    // Denying only ever reduces what runs, and is scoped to the caller's own
    // pending requests in the caller's workspace.
    const denied = await resolveApproval(
      params.requestId,
      "denied",
      `agent:${ctx.agentId}`,
      "Denied via approval_resolve tool",
      { uid: ctx.uid, workspaceId: ctx.workspaceId },
    );
    void denied;
    const pending = await getPendingApprovals(ctx.uid);
    const stillPending = pending.some((a) => a.id === params.requestId);
    return stillPending
      ? { error: `Request ${params.requestId} not found for this user/workspace.` }
      : { result: `Request ${params.requestId} denied.` };
  },
});
