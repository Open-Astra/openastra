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
    "Manage human-in-the-loop approval requests. List pending approvals or approve/deny a specific request.",
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

    const resolution = params.action === "approve" ? "approved" : "denied";
    resolveApproval(params.requestId, resolution, ctx.uid);
    return { result: `Request ${params.requestId} ${resolution}.` };
  },
});
