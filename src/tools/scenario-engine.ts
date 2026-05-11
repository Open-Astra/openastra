import { z } from "zod";
import { registerTool } from "./registry.js";
import { createBranch, abandonBranch } from "../memory/branches.js";
import { getAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";

// ── scenario_engine ─────────────────────────────────────────────────
// What-If Scenario Engine. Creates parallel memory branches for each
// scenario, runs simulations via agent inference, then compares
// outcomes side-by-side with a diff.

const ScenarioEngineParams = z.object({
  action: z
    .enum(["compare", "run_single", "list", "cleanup"])
    .describe("Action: compare multiple scenarios, run a single what-if, list past scenarios, or cleanup old branches"),
  scenarios: z
    .array(
      z.object({
        name: z.string().describe("Scenario name"),
        description: z.string().describe("What-if scenario description"),
        assumptions: z.array(z.string()).optional().describe("Key assumptions for this scenario"),
      }),
    )
    .optional()
    .describe("Scenarios to compare (for compare action)"),
  question: z.string().optional().describe("The what-if question to explore"),
  scenario_name: z.string().optional().describe("Name for single scenario (for run_single)"),
});

registerTool({
  name: "scenario_engine",
  description:
    "What-If Scenario Engine. Run parallel simulations by forking memory into branches, analyzing each scenario independently, and comparing outcomes side-by-side.",
  parameters: ScenarioEngineParams,

  async execute(params, ctx) {
    switch (params.action) {
      case "compare": {
        if (!params.scenarios || params.scenarios.length < 2) {
          return { error: "At least 2 scenarios required for compare" };
        }
        if (!params.question) return { error: "question required for compare" };

        const results: Array<{
          name: string;
          branchId: string;
          analysis: string;
          assumptions: string[];
        }> = [];

        const agentConfig = getAgentConfig(ctx.agentId);
        const client = getInferenceClientForAgent(agentConfig);

        for (const scenario of params.scenarios) {
          // Create a memory branch for this scenario
          const branch = await createBranch(
            ctx.uid,
            `scenario-${scenario.name}`,
            `What-if: ${scenario.description}`,
          );

          // Run inference to analyze this scenario
          const prompt = `Analyze this what-if scenario:
Question: ${params.question}
Scenario: ${scenario.name} — ${scenario.description}
Assumptions: ${(scenario.assumptions ?? []).join("; ")}

Provide:
1. Expected outcome
2. Key risks
3. Confidence level (0-100%)
4. Recommended actions

Be concise and specific.`;

          try {
            const response = await client.chat({
              messages: [
                { role: "system", content: "You are a strategic scenario analyst. Provide clear, actionable analysis." },
                { role: "user", content: prompt },
              ],
              temperature: 0.5,
              maxTokens: 1500,
            });

            results.push({
              name: scenario.name,
              branchId: branch.id,
              analysis: response.content ?? "No analysis generated",
              assumptions: scenario.assumptions ?? [],
            });
          } catch (err) {
            results.push({
              name: scenario.name,
              branchId: branch.id,
              analysis: `Error: ${err instanceof Error ? err.message : String(err)}`,
              assumptions: scenario.assumptions ?? [],
            });
          }
        }

        // Generate comparison summary
        const comparisonPrompt = `Compare these scenario analyses and recommend the best path:

${results.map((r) => `## ${r.name}\n${r.analysis}`).join("\n\n")}

Provide:
1. Best scenario and why
2. Key differentiators between scenarios
3. Combined risk assessment
4. Final recommendation`;

        let comparison = "";
        try {
          const compResponse = await client.chat({
            messages: [
              { role: "system", content: "You are a strategic advisor comparing scenario outcomes." },
              { role: "user", content: comparisonPrompt },
            ],
            temperature: 0.3,
            maxTokens: 2000,
          });
          comparison = compResponse.content ?? "";
        } catch {
          comparison = "Comparison generation failed";
        }

        return {
          result: `${results.length} scenarios compared`,
          question: params.question,
          scenarios: results.map((r) => ({
            name: r.name,
            branchId: r.branchId,
            analysis: r.analysis.slice(0, 2000),
          })),
          comparison,
        };
      }

      case "run_single": {
        if (!params.question) return { error: "question required" };

        const name = params.scenario_name ?? "what-if";
        const branch = await createBranch(ctx.uid, `scenario-${name}`, `What-if: ${params.question}`);

        const agentConfig = getAgentConfig(ctx.agentId);
        const client = getInferenceClientForAgent(agentConfig);

        const response = await client.chat({
          messages: [
            { role: "system", content: "You are a what-if scenario analyst. Explore the question thoroughly." },
            { role: "user", content: `Explore this what-if question: ${params.question}` },
          ],
          temperature: 0.6,
          maxTokens: 2000,
        });

        return {
          result: "Scenario explored",
          question: params.question,
          branchId: branch.id,
          analysis: response.content ?? "No analysis generated",
        };
      }

      case "list": {
        const pool = (await import("../config/postgres.js")).getPool();
        const { rows } = await pool.query<{
          id: string;
          name: string;
          description: string;
          status: string;
          created_at: string;
        }>(
          `SELECT id, name, description, status, created_at
           FROM memory_branches
           WHERE user_id = $1 AND name LIKE 'scenario-%'
           ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid],
        );

        return {
          result: `${rows.length} scenario branch(es)`,
          scenarios: rows.map((r) => ({
            branchId: r.id,
            name: r.name,
            description: r.description,
            status: r.status,
            createdAt: r.created_at,
          })),
        };
      }

      case "cleanup": {
        const pool = (await import("../config/postgres.js")).getPool();
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM memory_branches
           WHERE user_id = $1 AND name LIKE 'scenario-%' AND status = 'active'`,
          [ctx.uid],
        );

        let cleaned = 0;
        for (const row of rows) {
          await abandonBranch(ctx.uid, row.id);
          cleaned++;
        }

        return { result: `Cleaned up ${cleaned} scenario branch(es)` };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
