#!/usr/bin/env node

// ── Astra TUI Setup Wizard ──────────────────────────────────────────
// Interactive terminal setup that asks all configuration questions,
// generates astra.yml and .env, and validates the setup.
//
// Usage:
//   npx tsx src/standalone/setup.ts
//   npm run setup
//
// Similar to how Claude Code's initial onboarding works — a friendly
// TUI that walks you through every configuration option.

import { createInterface } from "node:readline";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

// ── ANSI Helpers ───────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CELESTIAL = "\x1b[38;5;39m";

function banner(): void {
  console.log(`
${CELESTIAL}${BOLD}    ╔══════════════════════════════════════════╗
    ║          ASTRA SETUP WIZARD              ║
    ║   Multi-Agent Runtime Configuration      ║
    ╚══════════════════════════════════════════╝${RESET}
`);
}

function section(title: string): void {
  console.log(`\n${CYAN}${BOLD}── ${title} ${"─".repeat(50 - title.length)}${RESET}\n`);
}

function success(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

// ── Readline ────────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${DIM}(${hint})${RESET}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

function askChoice(question: string, options: string[], defaultIndex: number = 0): Promise<string> {
  console.log(`  ${question}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? `${GREEN}>${RESET}` : " ";
    console.log(`    ${marker} ${i + 1}. ${options[i]}`);
  }
  return new Promise((resolve) => {
    rl.question(`  ${DIM}Enter number (${defaultIndex + 1})${RESET}: `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      resolve(options[idx >= 0 && idx < options.length ? idx : defaultIndex]!);
    });
  });
}

// ── Config Types ────────────────────────────────────────────────────

interface SetupConfig {
  // Deployment
  deploymentMode: "standalone" | "server" | "docker";
  // Inference
  defaultProvider: string;
  apiKeys: Record<string, string>;
  // Database
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  // Features
  enableDreamMode: boolean;
  dreamHour: number;
  dreamIntensity: string;
  enableResearch: boolean;
  enableEvolution: boolean;
  // Local models
  useOllama: boolean;
  ollamaUrl: string;
  // Channels
  enableTelegram: boolean;
  telegramToken: string;
  enableDiscord: boolean;
  discordToken: string;
  // Security
  jwtSecret: string;
  internalApiKey: string;
  // File access
  defaultFileAccessPath: string;
  restrictFileAccess: boolean;
  // Quotas
  quotaTier: string;
}

// ── Main Setup Flow ─────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  console.log(`  Welcome to Astra! This wizard will help you configure your`);
  console.log(`  multi-agent runtime. Press Enter to accept defaults.\n`);

  const config: Partial<SetupConfig> = {};

  // ── Deployment Mode ─────────────────────────────────────────────

  section("Deployment Mode");
  info("How will you run Astra?");
  config.deploymentMode = await askChoice(
    "Select deployment mode:",
    ["standalone — CLI agent, minimal setup", "server — Full HTTP/WS gateway", "docker — Docker Compose (recommended)"],
    2,
  ) as any;
  config.deploymentMode = config.deploymentMode!.split(" —")[0] as SetupConfig["deploymentMode"];

  // ── Inference Provider ──────────────────────────────────────────

  section("Inference Provider");
  info("Which LLM provider should be the default?");
  const providerChoice = await askChoice(
    "Default provider:",
    ["claude (Anthropic)", "grok (x.ai)", "openai (OpenAI)", "gemini (Google)", "ollama (Local)"],
    0,
  );
  config.defaultProvider = providerChoice.split(" (")[0]!;

  config.apiKeys = {};

  if (config.defaultProvider === "claude" || await askYesNo("Add Anthropic/Claude API key?", false)) {
    const key = await ask("ANTHROPIC_API_KEY");
    if (key) config.apiKeys.ANTHROPIC_API_KEY = key;
  }
  if (config.defaultProvider === "grok" || await askYesNo("Add Grok/x.ai API key?", false)) {
    const key = await ask("GROK_API_KEY");
    if (key) config.apiKeys.GROK_API_KEY = key;
  }
  if (config.defaultProvider === "openai" || await askYesNo("Add OpenAI API key?", false)) {
    const key = await ask("OPENAI_API_KEY");
    if (key) config.apiKeys.OPENAI_API_KEY = key;
  }
  if (config.defaultProvider === "gemini" || await askYesNo("Add Google Gemini API key?", false)) {
    const key = await ask("GEMINI_API_KEY");
    if (key) config.apiKeys.GEMINI_API_KEY = key;
  }

  // ── Database ────────────────────────────────────────────────────

  section("Database (PostgreSQL)");
  if (config.deploymentMode === "docker") {
    info("Docker Compose will create PostgreSQL automatically.");
    config.pgHost = "postgres";
    config.pgPort = 5432;
    config.pgDatabase = "astra";
    config.pgUser = "astra";
    config.pgPassword = await ask("Postgres password", "astra_secure_pw");
  } else {
    config.pgHost = await ask("PostgreSQL host", "localhost");
    config.pgPort = parseInt(await ask("PostgreSQL port", "5432"), 10);
    config.pgDatabase = await ask("Database name", "astra");
    config.pgUser = await ask("Database user", "astra");
    config.pgPassword = await ask("Database password", "astra");
  }

  // ── Local Models ────────────────────────────────────────────────

  section("Local Models (Ollama)");
  config.useOllama = await askYesNo("Enable Ollama for local model routing?", true);
  if (config.useOllama) {
    config.ollamaUrl = await ask("Ollama URL", "http://localhost:11434");
    info("Ollama will be used for dream mode and low-complexity queries.");
  }

  // ── Dream Mode ──────────────────────────────────────────────────

  section("Dream Mode (Offline Simulation)");
  info("Agents simulate future scenarios overnight using local models.");
  config.enableDreamMode = await askYesNo("Enable dream mode?", true);
  if (config.enableDreamMode) {
    const hour = await ask("Dream start hour (0-23, 24h format)", "23");
    config.dreamHour = parseInt(hour, 10);
    const intensity = await askChoice(
      "Dream intensity:",
      ["light — 5 min, quick insights", "medium — 15 min, scenario simulation", "deep — 30 min, full graph evolution"],
      1,
    );
    config.dreamIntensity = intensity.split(" —")[0]!;
  }

  // ── Deep Research ───────────────────────────────────────────────

  section("Deep Research Mode");
  info("PhD-style autonomous research that runs for hours/days.");
  config.enableResearch = await askYesNo("Enable deep research mode?", true);

  // ── Persona Evolution ───────────────────────────────────────────

  section("Agent Evolution");
  info("Agents can A/B test and evolve their own prompts based on feedback.");
  config.enableEvolution = await askYesNo("Enable persona evolution?", false);

  // ── Channels ────────────────────────────────────────────────────

  section("Messaging Channels");
  config.enableTelegram = await askYesNo("Enable Telegram bot?", false);
  if (config.enableTelegram) {
    config.telegramToken = await ask("Telegram bot token");
  }
  config.enableDiscord = await askYesNo("Enable Discord bot?", false);
  if (config.enableDiscord) {
    config.discordToken = await ask("Discord bot token");
  }

  // ── File Access ─────────────────────────────────────────────────

  section("File Access Restrictions");
  info("By default, agents can only access one folder.");
  info("This is a safety feature to prevent unintended file access.");
  config.restrictFileAccess = await askYesNo("Restrict file access to a specific folder?", true);
  if (config.restrictFileAccess) {
    config.defaultFileAccessPath = await ask("Allowed folder path", "~/AstraData");
  }

  // ── Quotas ──────────────────────────────────────────────────────

  section("Resource Quotas");
  const tierChoice = await askChoice(
    "Default quota tier:",
    ["free — Conservative limits", "premium — Standard limits (recommended)", "internal — No limits"],
    1,
  );
  config.quotaTier = tierChoice.split(" —")[0]!;

  // ── Security ────────────────────────────────────────────────────

  section("Security");
  const crypto = await import("node:crypto");
  config.jwtSecret = crypto.randomBytes(32).toString("hex");
  config.internalApiKey = crypto.randomBytes(24).toString("hex");
  success("Generated JWT secret");
  success("Generated internal API key");

  // ── Generate Files ──────────────────────────────────────────────

  section("Generating Configuration");

  const cwd = process.cwd();

  // Generate .env
  const envLines: string[] = [
    "# ── Astra Environment Configuration ──",
    `# Generated by setup wizard on ${new Date().toISOString()}`,
    "",
    `JWT_SECRET=${config.jwtSecret}`,
    `INTERNAL_API_KEY=${config.internalApiKey}`,
    "",
    "# Database",
    `PG_HOST=${config.pgHost}`,
    `PG_PORT=${config.pgPort}`,
    `PG_DATABASE=${config.pgDatabase}`,
    `PG_USER=${config.pgUser}`,
    `PG_PASSWORD=${config.pgPassword}`,
    "",
    "# Typesense",
    "TYPESENSE_API_KEY=astra-typesense-key",
    "TYPESENSE_HOST=typesense",
    "TYPESENSE_PORT=8108",
    "",
  ];

  for (const [key, value] of Object.entries(config.apiKeys ?? {})) {
    envLines.push(`${key}=${value}`);
  }

  if (config.useOllama) {
    envLines.push("", `OLLAMA_BASE_URL=${config.ollamaUrl}`);
  }
  if (config.telegramToken) {
    envLines.push("", `TELEGRAM_BOT_TOKEN=${config.telegramToken}`);
  }
  if (config.discordToken) {
    envLines.push("", `DISCORD_BOT_TOKEN=${config.discordToken}`);
  }

  const envPath = join(cwd, ".env");
  let writeEnv = true;
  try {
    await access(envPath);
    writeEnv = await askYesNo(".env already exists. Overwrite?", false);
  } catch {
    // File doesn't exist — safe to write
  }

  if (writeEnv) {
    await writeFile(envPath, envLines.join("\n") + "\n");
    success("Generated .env");
  } else {
    warn("Skipped .env (already exists)");
  }

  // Update astra.yml settings sections
  const yamlPath = join(cwd, "astra.yml");
  let yamlExists = false;
  try {
    await access(yamlPath);
    yamlExists = true;
  } catch {
    // Does not exist
  }

  if (!yamlExists) {
    // Generate a minimal astra.yml
    const yaml = `# ── Astra Agent Configuration ──
# Generated by setup wizard

settings:
  defaultAgent: assistant
  defaultProvider: ${config.defaultProvider}
  defaultModel: ${config.defaultProvider === "claude" ? "claude-sonnet-4-6" : config.defaultProvider === "grok" ? "grok-4.1-fast" : config.defaultProvider === "openai" ? "gpt-4o" : config.defaultProvider === "gemini" ? "gemini-2.0-flash" : "llama3.1"}

dream:
  enabled: ${config.enableDreamMode ?? false}
  intensity: ${config.dreamIntensity ?? "medium"}
  scheduleHour: ${config.dreamHour ?? 23}
  useLocalOnly: true
  promptUser: true

research:
  maxDurationHours: 24
  depth: moderate
  extractToGraph: true

evolution:
  enabled: ${config.enableEvolution ?? false}
  autoAdopt: false

${config.restrictFileAccess ? `fileAccess:
  restricted: true
  allowedPaths:
    - ${config.defaultFileAccessPath}
` : ""}
agents:
  assistant:
    displayName: Astra Assistant
    tier: ${config.quotaTier ?? "premium"}
    model:
      provider: ${config.defaultProvider}
    systemPrompt: |
      You are Astra, a versatile AI assistant with persistent memory.
      You remember past conversations and can search your memory semantically.
    skills:
      - brave_search
      - summarize
      - calculator
    tools:
      allow:
        - memory-write
        - memory-search
      deny: []
`;
    await writeFile(yamlPath, yaml);
    success("Generated astra.yml");
  } else {
    success("astra.yml already exists (keeping current config)");
  }

  // ── Summary ─────────────────────────────────────────────────────

  section("Setup Complete");
  console.log(`
  ${GREEN}${BOLD}Astra is configured!${RESET}

  ${BOLD}Next steps:${RESET}
${config.deploymentMode === "docker" ? `
    ${CYAN}1.${RESET} docker compose up -d
    ${CYAN}2.${RESET} Open http://localhost:8080/health
` : config.deploymentMode === "server" ? `
    ${CYAN}1.${RESET} npm run dev
    ${CYAN}2.${RESET} Open http://localhost:8080/health
` : `
    ${CYAN}1.${RESET} npm run cli
`}
  ${BOLD}Configuration files:${RESET}
    ${DIM}•${RESET} .env — API keys and secrets
    ${DIM}•${RESET} astra.yml — Agent team configuration
    ${DIM}•${RESET} SOUL.md — Ethical framework (loaded into all agents)

  ${DIM}Run 'npm run setup' again to reconfigure at any time.${RESET}
`);

  rl.close();
}

main().catch((err) => {
  console.error(`${RED}Setup failed:${RESET}`, err);
  rl.close();
  process.exit(1);
});
