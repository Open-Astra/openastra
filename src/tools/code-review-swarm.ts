import { z } from "zod";
import { registerTool } from "./registry.js";
import { runSwarm, type SwarmConfig } from "../agents/swarm.js";
import { getAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { SYSTEM_CAPS } from "../agents/budgets.js";

// ── code_review_swarm ───────────────────────────────────────────────
// Spawns a swarm of specialized review agents (security auditor,
// performance analyst, style checker, test coverage reviewer) that
// independently analyze code and merge findings on the blackboard.

const CodeReviewSwarmParams = z.object({
  code: z.string().describe("Source code to review"),
  language: z
    .string()
    .optional()
    .describe("Programming language (auto-detected if omitted)"),
  reviewers: z
    .array(z.enum(["security", "performance", "style", "architecture", "test_coverage"]))
    .default(["security", "performance", "style"])
    .describe("Which reviewer perspectives to include"),
  severity_threshold: z
    .enum(["critical", "warning", "info"])
    .default("warning")
    .describe("Minimum severity to report"),
});

registerTool({
  name: "code_review_swarm",
  description:
    "Launch an autonomous code review swarm — multiple specialized agents (security, performance, style, architecture, test coverage) review code independently, debate conflicts, and produce a merged report.",
  parameters: CodeReviewSwarmParams,

  async execute(params, ctx) {
    const lang = params.language ?? "auto-detect";
    const reviewerList = params.reviewers.join(", ");

    const task = `Review the following ${lang} code from ${reviewerList} perspectives.
Report issues at severity >= ${params.severity_threshold}.
For each issue provide: line number (if applicable), severity, category, message, and a concrete fix suggestion.

\`\`\`
${params.code.slice(0, 15000)}
\`\`\`

Output a structured JSON array of issues. If reviewers disagree on severity, flag the conflict.`;

    const baseConfig = getAgentConfig(ctx.agentId);
    const client = getInferenceClientForAgent(baseConfig);

    const swarmConfig: SwarmConfig = {
      maxAgents: params.reviewers.length + 1, // reviewers + synthesizer
      maxDepth: 2,
      timeoutMs: 120_000,
      parentBudget: SYSTEM_CAPS,
    };

    try {
      const result = await runSwarm(ctx.uid, task, baseConfig, client, swarmConfig);

      return {
        success: true,
        swarmId: result.swarmId,
        agentCount: result.agentCount,
        reviewers: params.reviewers,
        report: result.content,
        totalTokens: result.totalTokens,
        durationMs: result.totalDurationMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },
});
