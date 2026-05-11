import { getAgentConfigById } from "../agents/config-store.js";
import { getInferenceClientForAgent } from "../inference/factory.js";

// ── Agent Benchmarking ─────────────────────────────────────────────
// `astra bench` — run a suite of prompts against an agent configuration
// and report latency, token usage, cost, and quality metrics.
// Outputs a markdown table for easy sharing.

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

interface BenchResult {
  prompt: string;
  agentId: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseLength: number;
  error?: string;
}

// ── Default Benchmark Prompts ──────────────────────────────────────

const DEFAULT_PROMPTS = [
  { name: "Simple Q&A", prompt: "What is the capital of France? Answer in one word." },
  { name: "Reasoning", prompt: "If a train travels at 60mph for 2.5 hours, how far does it go? Show your work." },
  { name: "Code Gen", prompt: "Write a TypeScript function that checks if a string is a valid email address." },
  { name: "Summarize", prompt: "Summarize the concept of machine learning in exactly 3 sentences." },
  { name: "Creative", prompt: "Write a haiku about debugging code at 3am." },
  { name: "Structured", prompt: "List the 5 most common HTTP status codes with their meanings in JSON format." },
  { name: "Analysis", prompt: "Compare REST and GraphQL APIs. Give 3 pros and 3 cons of each in a table." },
  { name: "Long Output", prompt: "Write a step-by-step tutorial for setting up a PostgreSQL database with Docker, including all commands." },
];

// ── Cost Estimation ────────────────────────────────────────────────

const MODEL_COSTS: Record<string, { prompt: number; completion: number }> = {
  "claude-opus-4-6": { prompt: 15 / 1_000_000, completion: 75 / 1_000_000 },
  "claude-sonnet-4-6": { prompt: 3 / 1_000_000, completion: 15 / 1_000_000 },
  "claude-haiku-4-5-20251001": { prompt: 0.8 / 1_000_000, completion: 4 / 1_000_000 },
  "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
  "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
  "gemini-2.0-flash": { prompt: 0.1 / 1_000_000, completion: 0.4 / 1_000_000 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const costs = MODEL_COSTS[model];
  if (!costs) return 0;
  return promptTokens * costs.prompt + completionTokens * costs.completion;
}

// ── Benchmark Runner ───────────────────────────────────────────────

export async function runBench(): Promise<void> {
  const args = process.argv.slice(2).filter((a: string) => a !== "bench");
  const agentId = args.find((a: string) => !a.startsWith("--")) ?? "default";
  const iterations = parseInt(args.find((a: string) => a.startsWith("--iterations="))?.split("=")[1] ?? "1", 10);
  const outputFormat = args.includes("--json") ? "json" : "table";

  console.log(`\n${BOLD}  Astra Agent Benchmark${RESET}`);
  console.log(`${DIM}  ─────────────────────────────────────────${RESET}`);
  console.log(`  ${DIM}Agent:${RESET}      ${agentId}`);
  console.log(`  ${DIM}Prompts:${RESET}    ${DEFAULT_PROMPTS.length}`);
  console.log(`  ${DIM}Iterations:${RESET} ${iterations}`);
  console.log(`${DIM}  ─────────────────────────────────────────${RESET}\n`);

  const results: BenchResult[] = [];
  const total = DEFAULT_PROMPTS.length * iterations;
  let completed = 0;

  for (let iter = 0; iter < iterations; iter++) {
    for (const { name, prompt } of DEFAULT_PROMPTS) {
      completed++;
      const progress = `[${completed}/${total}]`;
      process.stdout.write(`  ${DIM}${progress}${RESET} Running "${name}"...`);

      const start = Date.now();
      try {
        // Try to get inference client for the agent
        let response = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let model = "unknown";

        try {
          const agentConfig = await getAgentConfigById(agentId);

          if (agentConfig) {
            model = `${agentConfig.model.provider}:${agentConfig.model.modelId}`;
            const client = getInferenceClientForAgent(agentConfig);

            const result = await client.chat({
              messages: [{ role: "user", content: prompt }],
              maxTokens: 1024,
            });

            response = result.content ?? "";
            promptTokens = result.usage?.promptTokens ?? 0;
            completionTokens = result.usage?.completionTokens ?? 0;
          }
        } catch (err) {
          // Fallback: just record the error
          const latencyMs = Date.now() - start;
          results.push({
            prompt: name,
            agentId,
            model: "error",
            latencyMs,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            responseLength: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          console.log(` ${RED}ERROR${RESET} (${Date.now() - start}ms)`);
          continue;
        }

        const latencyMs = Date.now() - start;
        results.push({
          prompt: name,
          agentId,
          model,
          latencyMs,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          responseLength: response.length,
        });

        console.log(` ${GREEN}OK${RESET} (${latencyMs}ms, ${promptTokens + completionTokens} tok)`);
      } catch (err) {
        const latencyMs = Date.now() - start;
        results.push({
          prompt: name,
          agentId,
          model: "error",
          latencyMs,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          responseLength: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        console.log(` ${RED}FAIL${RESET} (${latencyMs}ms)`);
      }
    }
  }

  console.log();

  if (outputFormat === "json") {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  // Print results table
  printResultsTable(results);

  // Print summary
  const successful = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  if (successful.length > 0) {
    const avgLatency = Math.round(successful.reduce((s, r) => s + r.latencyMs, 0) / successful.length);
    const totalTokens = successful.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost = successful.reduce((s, r) => s + estimateCost(r.model, r.promptTokens, r.completionTokens), 0);

    console.log(`\n${BOLD}  Summary${RESET}`);
    console.log(`${DIM}  ─────────────────────────────────────────${RESET}`);
    console.log(`  ${GREEN}Passed:${RESET}     ${successful.length}/${results.length}`);
    if (failed.length > 0) console.log(`  ${RED}Failed:${RESET}     ${failed.length}`);
    console.log(`  ${DIM}Avg Latency:${RESET} ${avgLatency}ms`);
    console.log(`  ${DIM}Total Tokens:${RESET} ${totalTokens.toLocaleString()}`);
    console.log(`  ${DIM}Est. Cost:${RESET}   $${totalCost.toFixed(4)}`);
    console.log();
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

function printResultsTable(results: BenchResult[]): void {
  console.log(`${BOLD}  Results${RESET}`);
  console.log(`${DIM}  ─────────────────────────────────────────────────────────────────────${RESET}`);
  console.log(`  ${DIM}${"Prompt".padEnd(15)} ${"Model".padEnd(20)} ${"Latency".padStart(8)} ${"Tokens".padStart(8)} ${"Cost".padStart(8)} Status${RESET}`);
  console.log(`  ${DIM}${"─".repeat(15)} ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ──────${RESET}`);

  for (const r of results) {
    const status = r.error ? `${RED}FAIL${RESET}` : `${GREEN}OK${RESET}`;
    const cost = estimateCost(r.model, r.promptTokens, r.completionTokens);
    const costStr = cost > 0 ? `$${cost.toFixed(4)}` : "—";

    console.log(
      `  ${r.prompt.padEnd(15)} ${r.model.slice(0, 20).padEnd(20)} ${`${r.latencyMs}ms`.padStart(8)} ${r.totalTokens.toString().padStart(8)} ${costStr.padStart(8)} ${status}`,
    );
  }
}
