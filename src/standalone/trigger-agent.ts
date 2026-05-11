#!/usr/bin/env node

// Load .env before anything else reads process.env
import "dotenv/config";

// Suppress noisy internal logging for standalone scripts
process.env.ASTRA_STANDALONE = "true";

import "../utils/console-scrub.js";

// ── Trigger Agent ─────────────────────────────────────────────────
// Manually trigger a scheduled agent outside the cron scheduler.
// Runs the exact same code path as production — just on demand.
//
// Usage:
//   npm run trigger -- researcher
//   npm run trigger -- assistant "Custom task message here"

import { initPostgres, getPool, closePool } from "../config/postgres.js";
import { runMigrations } from "../db/migrate.js";
import { loadAstraConfig, seedAgentsFromConfig } from "../config/yaml-loader.js";
import { getAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { runAutonomousAgent } from "../agents/autonomous.js";
import { createLogger } from "../utils/logger.js";

// Register all tools
import "../tools/index.js";

const log = createLogger("trigger-agent");


async function main(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error("Usage: npm run trigger -- <agent_id> [task_message]");
    console.error("Example: npm run trigger -- researcher");
    process.exit(1);
  }

  const customMessage = process.argv[3];

  // 1. Init postgres + run migrations
  initPostgres();
  await runMigrations();

  // 2. Load astra.yml and seed agent configs
  const yamlConfig = await loadAstraConfig();
  if (!yamlConfig) {
    log.error("No astra.yml found — cannot resolve agent configs");
    process.exit(1);
  }
  seedAgentsFromConfig(yamlConfig);

  // 3. Resolve agent config
  let agentConfig;
  try {
    agentConfig = getAgentConfig(agentId);
  } catch {
    log.error(`Unknown agent: ${agentId}`);
    process.exit(1);
  }

  // 4. Build inference client
  const client = getInferenceClientForAgent(agentConfig);

  // 5. Ensure system user exists (same as cron.ts)
  const uid = `trigger:${agentId}`;
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [uid, `${uid}@system`, "system", `Trigger ${agentId}`],
  );

  // 6. Run
  const taskMessage = customMessage ?? agentConfig.schedule?.taskMessage ?? `Run ${agentId}`;
  log.info(`Triggering ${agentId} with uid="${uid}"`);
  log.info(`Task: ${taskMessage.slice(0, 120)}${taskMessage.length > 120 ? "..." : ""}`);

  const startTime = Date.now();
  try {
    const response = await runAutonomousAgent(uid, agentConfig, taskMessage, client);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n─── Result ───────────────────────────────────────");
    console.log(`Session:  ${response.sessionId}`);
    console.log(`Tokens:   ${response.tokenUsage.total} (prompt: ${response.tokenUsage.prompt}, completion: ${response.tokenUsage.completion})`);
    console.log(`Tools:    ${response.toolResults.length} calls`);
    console.log(`Duration: ${elapsed}s`);
    console.log("──────────────────────────────────────────────────\n");
    console.log(response.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Agent failed after ${((Date.now() - startTime) / 1000).toFixed(1)}s: ${msg}`);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
