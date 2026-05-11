#!/usr/bin/env node

// Load .env file before anything else reads process.env
import "dotenv/config";

// Suppress noisy internal logging (event bus, cache metrics, trace lines)
// Must be set before any imports so singleton initializers see it.
process.env.ASTRA_STANDALONE = "true";

// Patch console.log/warn/error to scrub secrets from all output
import "../utils/console-scrub.js";

// ── Astra Standalone CLI ─────────────────────────────────────────
// Interactive terminal agent — chat directly with your agent, no
// server required. Streams responses in real-time with tool feedback.
//
// Usage:
//   npm run cli                          # start interactive chat
//   npm run cli -- --provider claude     # force provider
//   npm run cli -- --model gpt-4o        # force model
//   npm run cli -- --agent my-agent      # use specific agent ID
//   npm run cli -- --reset               # reset session on start

import { createInterface } from "node:readline";
import { loadStandaloneEnv, type StandaloneEnv } from "./env.js";
import { initPostgres, closePool, getPool } from "../config/postgres.js";
import { initJwt } from "../auth/jwt.js";
import { runMigrations } from "../db/migrate.js";
import { loadAgentConfigs } from "../agents/config-store.js";
import { getAgentConfig, registerAgentConfig } from "../config/agents.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { runAgentLoopStream } from "../agents/loop-stream.js";
import { createStandaloneToolFilter } from "./tool-router.js";
import { resetSession } from "../sessions/store.js";
import { getEventBus } from "../events/index.js";
import { registerTool, getRegisteredToolNames } from "../tools/registry.js";
import type { AgentConfig } from "../agents/types.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionKey } from "../sessions/types.js";

// Import tools to trigger registration
import "../tools/index.js";

// Skills system
import type { SkillDefinition } from "../skills/types.js";
import { discoverSkills, initSkills, startSkills, stopSkills } from "../skills/loader.js";
import { getSkillToolNames } from "../skills/registry.js";

// ── ANSI Helpers ───────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CELESTIAL = "\x1b[38;5;39m";
const ICE = "\x1b[38;5;117m";

// ── CLI Argument Parsing ───────────────────────────────────────────

interface CliArgs {
  provider?: string;
  model?: string;
  agentId?: string;
  reset?: boolean;
  systemPrompt?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
        parsed.provider = args[++i];
        break;
      case "--model":
        parsed.model = args[++i];
        break;
      case "--agent":
        parsed.agentId = args[++i];
        break;
      case "--reset":
        parsed.reset = true;
        break;
      case "--system-prompt":
        parsed.systemPrompt = args[++i];
        break;
      case "--help":
        printUsage();
        process.exit(0);
    }
  }

  return parsed;
}

function printUsage(): void {
  console.log(`
${BOLD}Astra Standalone CLI${RESET}

${BOLD}Usage:${RESET}
  npm run cli [options]

${BOLD}Options:${RESET}
  --provider <name>       Inference provider (claude, openai, grok, gemini, ollama, vllm)
  --model <id>            Model ID (e.g., claude-sonnet-4-6, gpt-4o)
  --agent <id>            Use a specific agent config from the database
  --reset                 Reset the session (clear conversation history)
  --system-prompt <text>  Override the system prompt
  --help                  Show this help message

${BOLD}Environment Variables:${RESET}
  ANTHROPIC_API_KEY       Claude provider
  OPENAI_API_KEY          OpenAI provider
  GROK_API_KEY            Grok/X.ai provider
  GEMINI_API_KEY          Gemini provider (also used for embeddings)
  PG_HOST, PG_PORT, etc.  PostgreSQL connection
  TYPESENSE_API_KEY       Optional — enables semantic memory search
  BRAVE_API_KEY           Optional — enables web search skill
  STANDALONE_PROVIDER     Override auto-detected provider
  STANDALONE_MODEL        Override auto-detected model

${BOLD}Commands (in chat):${RESET}
  /reset                  Reset conversation (new session)
  /config                 Show current agent configuration
  /sessions               Show active session info
  /help                   Show available commands
  /quit, /exit            Exit the CLI
`);
}

// ── Default Agent Config ───────────────────────────────────────────

// Tools that require server-mode features unavailable in standalone CLI
const STANDALONE_TOOL_DENY = new Set([
  "agent_spawn",          // spawn.enabled = false, no target agents
  "agent_therapy",        // requires multi-agent server
  "agent_specialization_router", // no agent registry in standalone
  "swarm_observer",       // no swarm in standalone
  "code_review_swarm",    // no swarm in standalone
  "meta_controller",      // no swarm in standalone
  "debate_witnesses",     // no swarm in standalone
  "push_notify",          // no notification service
  "email_send",           // requires RESEND_API_KEY + server routing
]);

function createDefaultAgentConfig(env: StandaloneEnv, args: CliArgs): AgentConfig {
  const provider = (args.provider ?? env.defaultProvider) as AgentConfig["model"]["provider"];
  const modelId = args.model ?? env.defaultModel;

  const defaultSkills: string[] = [];
  if (env.braveApiKey) defaultSkills.push("brave_search");

  const workspacePath = process.env.ASTRA_WORKSPACE_DIR ?? join(homedir(), "desktop", "projects", "openastra-workspace");
  const isWindows = process.platform === "win32";

  return {
    id: "standalone",
    displayName: "Astra Assistant",
    tier: "internal",
    model: {
      provider,
      modelId,
      maxContextTokens: provider === "claude" ? 200_000 : 128_000,
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
    systemPromptTemplate: args.systemPrompt ??
      `You are Astra, a versatile AI assistant. You are helpful, concise, and accurate.

## Environment
- Platform: ${isWindows ? "Windows" : process.platform}
- Workspace directory: ${workspacePath}
- When the user says "workspace" or "workspace directory", they mean: ${workspacePath}
${isWindows ? '- Shell: cmd.exe — use "dir" instead of "ls", "type" instead of "cat", "findstr" instead of "grep"' : ""}

## Tool Usage Rules
- When calling a tool, always include ALL required parameters. Double-check the parameter names and types before calling.
- If a tool call fails, read the error message carefully. Fix the specific issue — do NOT retry the exact same call.
- If a tool fails twice for the same task, stop using that tool and either: answer from your own knowledge, try a different tool, or tell the user what went wrong and ask for guidance.
- Never apologize repeatedly for tool failures — acknowledge the issue once and move on to an alternative approach.
- To list files in a directory, use shell_execute with${isWindows ? ' "dir <path>"' : ' "ls <path>"'}.
- To read a file, use file_read with the full file path.

{{#if userProfile}}
## User Profile
{{userProfile}}
{{/if}}

{{#if dailyMemory}}
## Recent Activity
{{dailyMemory}}
{{/if}}

{{#if prefetchedContext}}
## Relevant Context
{{prefetchedContext}}
{{/if}}

{{#if skillContext}}
## Available Skills
{{skillContext}}
{{/if}}`,
    tools: {
      allow: getRegisteredToolNames().filter((name) =>
        // Exclude tools that don't work in standalone mode
        !STANDALONE_TOOL_DENY.has(name)
      ),
      deny: [...STANDALONE_TOOL_DENY],
      maxToolCallsPerRound: 8,
    },
    skills: defaultSkills,
    session: {
      dailyResetHour: 4,
      idleTimeoutMinutes: 480,
      maxContextMessages: 50,
    },
    spawn: {
      enabled: false,
      allowedTargets: [],
      maxDepth: 2,
    },
    fileAccess: {
      restricted: true,
      allowedPaths: [workspacePath],
    },
  };
}

// ── Initialization ─────────────────────────────────────────────────

async function initialize(env: StandaloneEnv, args: CliArgs): Promise<{
  agentConfig: AgentConfig;
  skills: SkillDefinition[];
}> {
  // Initialize JWT (needed internally even in standalone)
  initJwt({
    jwtSecret: env.jwtSecret,
    accessExpires: "24h",
    refreshExpires: "30d",
  });

  // Initialize PostgreSQL
  initPostgres({
    host: env.pgHost,
    port: env.pgPort,
    database: env.pgDatabase,
    user: env.pgUser,
    password: env.pgPassword,
    useSocket: false,
    maxConnections: env.pgMaxConnections,
  });

  // Run migrations
  await runMigrations();

  // Ensure standalone user exists (sessions FK requires a valid users row)
  const pool = getPool();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [LOCAL_UID, "standalone@local", "standalone", "Standalone User"],
  );

  // Initialize embeddings (local fallback if no Gemini key)
  const { initEmbeddings } = await import("../memory/embeddings.js");
  initEmbeddings(env.geminiApiKey);

  // Initialize Typesense + memory collections if configured
  if (env.typesenseApiKey) {
    const { initTypesense, ensureMemoryCollection } = await import("../config/typesense.js");
    const { ensureGraphSchema } = await import("../memory/graph.js");

    initTypesense({
      port: 8080,
      grokApiKey: env.grokApiKey ?? "",
      nodeEnv: "development",
      jwtSecret: env.jwtSecret,
      jwtAccessExpires: "24h",
      jwtRefreshExpires: "30d",
      typesenseApiKey: env.typesenseApiKey,
      typesenseHost: env.typesenseHost,
      typesensePort: env.typesensePort,
      typesenseProtocol: env.typesenseProtocol,
      geminiApiKey: env.geminiApiKey,
      internalApiKey: env.internalApiKey,
      xBearerToken: env.grokApiKey ?? "",
      allowedOrigins: [],
      grpcPort: 50051,
      grpcEnabled: false,
      pgHost: env.pgHost,
      pgPort: env.pgPort,
      pgDatabase: env.pgDatabase,
      pgUser: env.pgUser,
      pgPassword: env.pgPassword,
      pgUseSocket: false,
      pgMaxConnections: env.pgMaxConnections,
      secretBackend: "env",
      secretTtlSeconds: 300,
      bindJwtToDevice: false,
      memoryTtlDays: 90,
      inferencePayloadTtlDays: 30,
      semanticCacheEnabled: false,
      memoryBackendTimeoutMs: 500,
      piiDetectionPolicy: "redact" as const,
      codeExecSandbox: "process" as const,
      codeExecTimeoutMs: 10000,
      codeExecMemoryLimitMb: 128,
      codeExecDockerImage: "node:20-alpine",
      userRateLimitRpm: 60,
      userRateLimitBurst: 10,
      localDev: false,
      promptInjectionPolicy: "warn" as const,
      watermarkEnabled: false,
      warmPoolSize: 3,
      pgStandbyPort: 5432,
      pgFailoverEnabled: false,
      otelExportEnabled: false,
      zapierEnabled: false,
      jiraEnabled: false,
      costAnomalyThreshold: 3,
      pgReplicaPort: 5432,
      meshGossipEnabled: false,
      sanityDataset: "production",
      latencyTrendAlertThreshold: 50,
      cacheInvalidationBusEnabled: false,
      cacheCompressionEnabled: false,
      cacheCompressionThresholdBytes: 1024,
      mlCacheWarmingEnabled: false,
      cacheStreamingEnabled: false,
      requestCoalescingEnabled: false,
      tokenPredictionEnabled: false,
      adaptiveBatchingEnabled: false,
      extendedThinkingEnabled: false,
    });
    await ensureMemoryCollection();
    await ensureGraphSchema();
    console.log(`${DIM}[init] Typesense + embeddings: ready${RESET}`);
  } else {
    console.log(`${DIM}[init] Typesense: skipped (set TYPESENSE_API_KEY to enable)${RESET}`);
  }

  // Initialize event bus
  getEventBus();

  // Load existing agent configs from DB
  await loadAgentConfigs();

  // Seed agents from astra.yml (so YAML-defined agents like "researcher" are available)
  const { loadAstraConfig, seedAgentsFromConfig } = await import("../config/yaml-loader.js");
  const yamlConfig = await loadAstraConfig();
  if (yamlConfig) {
    seedAgentsFromConfig(yamlConfig);
    console.log(`${DIM}[init] astra.yml: agents seeded${RESET}`);
  }

  // Resolve agent config: use --agent flag, or create default
  let agentConfig: AgentConfig;

  if (args.agentId) {
    try {
      agentConfig = getAgentConfig(args.agentId);
    } catch {
      console.error(`${RED}Agent "${args.agentId}" not found in database.${RESET}`);
      process.exit(1);
    }
  } else {
    agentConfig = createDefaultAgentConfig(env, args);
    registerAgentConfig(agentConfig.id, agentConfig);
  }

  // Initialize skills
  const skillDir = fileURLToPath(new URL("../skills/definitions", import.meta.url));
  const sharedCtx = {
    app: null as unknown as import("express").Express,
    resolveClient: getInferenceClientForAgent,
    getEventBus,
    registerTool,
    registerAgentConfig,
    logger: {
      info: (...a: unknown[]) => console.log(`${DIM}[skill]`, ...a, RESET),
      error: (...a: unknown[]) => console.error(`${RED}[skill]`, ...a, RESET),
    },
  };
  const skills = await discoverSkills(skillDir);
  await initSkills(skills, sharedCtx);
  await startSkills(skills);

  return { agentConfig, skills };
}

// ── Chat Command Handling ──────────────────────────────────────────

const LOCAL_UID = "standalone_user";

async function handleCommand(
  command: string,
  agentConfig: AgentConfig,
  sessionKey: SessionKey,
): Promise<boolean> {
  switch (command) {
    case "/quit":
    case "/exit":
      return true;

    case "/reset":
      await resetSession(sessionKey, agentConfig);
      console.log(`\n${GREEN}Session reset. Starting fresh.${RESET}\n`);
      return false;

    case "/config":
      console.log(`\n${BOLD}Agent Configuration${RESET}`);
      console.log(`  ID:       ${agentConfig.id}`);
      console.log(`  Name:     ${agentConfig.displayName}`);
      console.log(`  Provider: ${agentConfig.model.provider}`);
      console.log(`  Model:    ${agentConfig.model.modelId}`);
      console.log(`  Context:  ${agentConfig.model.maxContextTokens.toLocaleString()} tokens`);
      console.log(`  Skills:   ${agentConfig.skills.length > 0 ? agentConfig.skills.join(", ") : "none"}`);
      console.log(`  Tools:    ${agentConfig.tools.allow.join(", ") || "none"}`);
      console.log();
      return false;

    case "/help":
      console.log(`\n${BOLD}Commands${RESET}`);
      console.log(`  /reset     Reset conversation (new session)`);
      console.log(`  /config    Show agent configuration`);
      console.log(`  /help      Show this help`);
      console.log(`  /quit      Exit\n`);
      return false;

    default:
      console.log(`${DIM}Unknown command: ${command}. Type /help for available commands.${RESET}`);
      return false;
  }
}

// ── Stream Response to Terminal ────────────────────────────────────

// Stateful filter — initialized in main() with agent skill tools so that
// skill-required tools are always visible.
let toolFilter = createStandaloneToolFilter();

async function streamResponse(
  message: string,
  agentConfig: AgentConfig,
  sessionKey: SessionKey,
): Promise<void> {
  const inferenceClient = getInferenceClientForAgent(agentConfig);

  const stream = runAgentLoopStream(
    LOCAL_UID,
    message,
    agentConfig,
    inferenceClient,
    sessionKey,
    undefined,               // signal
    undefined,               // workspaceId
    toolFilter,              // dynamic tool schema filter (stateful)
  );

  let hasContent = false;

  for await (const event of stream) {
    switch (event.type) {
      case "session_resolved":
        if (event.isNew) {
          console.log(`${DIM}(new session)${RESET}`);
        }
        break;

      case "stream_delta":
        if (!hasContent) {
          process.stdout.write(`\n${CYAN}`);
          hasContent = true;
        }
        process.stdout.write(event.content);
        break;

      case "tool_call_start":
        if (hasContent) {
          process.stdout.write(RESET);
          hasContent = false;
        }
        process.stdout.write(`\n  ${YELLOW}> ${event.name}${RESET} `);
        break;

      case "tool_result":
        if (event.error) {
          process.stdout.write(`${RED}failed (${event.durationMs}ms)${RESET}\n`);
          process.stdout.write(`  ${DIM}${RED}${event.error}${RESET}\n`);
        } else {
          process.stdout.write(`${GREEN}done (${event.durationMs}ms)${RESET}\n`);
        }
        break;

      case "retry_web_search":
        process.stdout.write(`\n  ${DIM}[searching the web...]${RESET}\n`);
        hasContent = false;
        break;

      case "completed": {
        if (hasContent) {
          process.stdout.write(RESET);
        }
        console.log();

        const { prompt, cached, total } = event.tokenUsage;
        const spent = total - cached;
        console.log(
          `${DIM}[${cached ? `${cached} cached | ` : ""}${spent} spent | ${total} total]${RESET}`,
        );
        if (cached) {
          const hitRate = ((cached / prompt) * 100).toFixed(1);
          console.log(`${DIM}[cache hit ${hitRate}%]${RESET}`);
        }
        console.log();
        break;
      }

      case "error":
        console.error(`\n${RED}Error: ${event.message}${RESET}\n`);
        break;
    }
  }
}

// ── Main REPL ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const env = loadStandaloneEnv();

  console.log(`
${CELESTIAL}     ░█▀█░█▀▀░▀█▀░█▀▄░█▀█${RESET}
${CELESTIAL}     ░█▀█░▀▀█░░█░░█▀▄░█▀█${RESET}
${CELESTIAL}     ░▀░▀░▀▀▀░░▀░░▀░▀░▀░▀${RESET}
${ICE}        ✦ Standalone Agent ✦${RESET}
`);

  console.log(`${DIM}  Initializing...${RESET}\n`);

  const { agentConfig, skills } = await initialize(env, args);

  // Re-initialize tool filter with agent's skill tools always visible
  if (agentConfig.skills.length > 0) {
    const skillToolSet = new Set(getSkillToolNames(agentConfig.skills));
    toolFilter = createStandaloneToolFilter(skillToolSet);
  }

  const sessionKey: SessionKey = {
    uid: LOCAL_UID,
    surface: "chat",
    surfaceId: "standalone",
  };

  // Reset session if --reset flag passed
  if (args.reset) {
    await resetSession(sessionKey, agentConfig);
    console.log(`${GREEN}  Session reset.${RESET}`);
  }

  // Service info
  console.log(`${DIM}    ─────────────────────────────────────────${RESET}`);
  console.log(`  ${DIM}[astra]${RESET} Provider   ${BOLD}${agentConfig.model.provider}/${agentConfig.model.modelId}${RESET}`);
  console.log(`  ${DIM}[astra]${RESET} PostgreSQL ${DIM}${env.pgHost}:${env.pgPort}/${env.pgDatabase}${RESET}`);
  if (env.typesenseApiKey) {
    console.log(`  ${DIM}[astra]${RESET} Typesense  ${DIM}${env.typesenseHost}:${env.typesensePort}${RESET}`);
  }
  console.log(`  ${DIM}[astra]${RESET} Embeddings ${DIM}${env.geminiApiKey ? "Gemini (cloud)" : "Local fallback"}${RESET}`);
  console.log(`  ${DIM}[astra]${RESET} Workspace  ${DIM}${agentConfig.fileAccess?.allowedPaths?.[0] ?? "unrestricted"}${RESET}`);
  console.log(`  ${DIM}[astra]${RESET} Tools      ${DIM}${agentConfig.tools.allow.length} registered${RESET}`);
  console.log(`  ${DIM}[astra]${RESET} Skills     ${DIM}${skills.length} loaded${RESET}`);
  console.log(`${DIM}    ─────────────────────────────────────────${RESET}`);
  console.log();
  console.log(`  ${GREEN}Ready.${RESET} ${DIM}Type /help for commands, /quit to exit.${RESET}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}you > ${RESET}`,
    terminal: true,
  });

  rl.prompt();

  let busy = false;

  // ── Multi-line paste support ───────────────────────────────────
  // Buffer lines during rapid paste (< 50ms between lines) and
  // flush them as a single prompt once the paste burst ends.
  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  const PASTE_DEBOUNCE_MS = 50;

  async function flushPasteBuffer(): Promise<void> {
    pasteTimer = null;
    const input = pasteBuffer.join("\n").trim();
    pasteBuffer = [];

    if (!input) {
      rl.prompt();
      return;
    }

    // Ignore input while a response is still streaming
    if (busy) {
      return;
    }

    // Handle slash commands (single-line only)
    if (input.startsWith("/") && !input.includes("\n")) {
      const shouldExit = await handleCommand(input, agentConfig, sessionKey);
      if (shouldExit) {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // Send message to agent
    busy = true;
    try {
      await streamResponse(input, agentConfig, sessionKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n${RED}Error: ${message}${RESET}\n`);
    } finally {
      busy = false;
      rl.prompt();
    }
  }

  rl.on("line", (line) => {
    pasteBuffer.push(line);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPasteBuffer, PASTE_DEBOUNCE_MS);
  });

  rl.on("close", async () => {
    console.log(`\n${DIM}Shutting down...${RESET}`);
    await stopSkills(skills);
    await closePool();
    process.exit(0);
  });

  // Graceful shutdown
  process.on("SIGINT", () => rl.close());
  process.on("SIGTERM", () => rl.close());
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${RED}Fatal: ${msg}${RESET}`);
  if (err instanceof Error && err.stack) {
    console.error(`${DIM}${err.stack}${RESET}`);
  }
  process.exit(1);
});
