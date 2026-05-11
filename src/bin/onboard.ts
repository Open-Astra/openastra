// ── First-Run Onboarding Wizard ─────────────────────────────────────
// Minimal wizard for `npx astra`. Supports three flags:
//   --quickstart       Provider + API key only; all else defaulted
//   --non-interactive  Derive everything from env vars; no prompts
//   --reset            Wipe existing config before running wizard

import { writeFile, access } from "node:fs/promises";
import {
  createRL, ask, askYesNo, askChoice, askSecret,
  banner, section, success, info, warn,
  BOLD, RESET, DIM, CYAN, GREEN,
} from "./tui.js";
import {
  type AstraCliConfig,
  generateSecrets, saveConfig, deleteConfig,
  ASTRA_HOME, DEFAULT_ASTRA_YML_PATH,
} from "./config.js";
import { checkDocker, startServices, waitForHealthy } from "./docker.js";
import { mkdir } from "node:fs/promises";

// ── Provider → env key mapping ──────────────────────────────────────

const PROVIDER_KEY_MAP: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  grok: "GROK_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const PROVIDER_MODELS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o",
  grok: "grok-4.1-fast",
  gemini: "gemini-2.5-pro",
  ollama: "llama3.1",
};

// ── Flag parsing ─────────────────────────────────────────────────────

interface OnboardingFlags {
  reset: boolean;
  nonInteractive: boolean;
  quickstart: boolean;
}

function parseFlags(): OnboardingFlags {
  const argv = process.argv;
  return {
    reset: argv.includes("--reset"),
    nonInteractive: argv.includes("--non-interactive") || argv.includes("--yes") || argv.includes("-y"),
    quickstart: argv.includes("--quickstart") || argv.includes("-q"),
  };
}

// ── Non-interactive config builder ──────────────────────────────────
// Derives config entirely from env vars for CI / scripted installs.

function buildConfigFromEnv(): AstraCliConfig {
  const provider = (process.env.DEFAULT_PROVIDER ?? "claude") as AstraCliConfig["defaultProvider"];

  const apiKeys: Record<string, string> = {};
  for (const envKey of Object.values(PROVIDER_KEY_MAP)) {
    const val = process.env[envKey];
    if (val) apiKeys[envKey] = val;
  }

  const secrets = generateSecrets();
  // Allow pre-seeding secrets for reproducible environments
  if (process.env.JWT_SECRET) secrets.jwtSecret = process.env.JWT_SECRET;
  if (process.env.INTERNAL_API_KEY) secrets.internalApiKey = process.env.INTERNAL_API_KEY;
  if (process.env.TYPESENSE_API_KEY) secrets.typesenseApiKey = process.env.TYPESENSE_API_KEY;
  if (process.env.PG_PASSWORD) secrets.pgPassword = process.env.PG_PASSWORD;

  return {
    defaultProvider: provider,
    apiKeys,
    ...secrets,
    gatewayPort: parseInt(process.env.GATEWAY_PORT ?? "8080", 10),
    pgPort: parseInt(process.env.PG_PORT ?? "5433", 10),
    typesensePort: parseInt(process.env.TYPESENSE_PORT ?? "8108", 10),
    braveApiKey: process.env.BRAVE_API_KEY,
    ollamaBaseUrl: provider === "ollama"
      ? (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434")
      : undefined,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runOnboarding(): Promise<AstraCliConfig> {
  const flags = parseFlags();

  // ── --reset: wipe existing config before proceeding ─────────────────
  if (flags.reset) {
    await deleteConfig();
    if (!flags.nonInteractive) {
      info("Previous config wiped. Starting fresh...\n");
    }
  }

  // ── --non-interactive: no prompts, derive from env vars ─────────────
  if (flags.nonInteractive) {
    const config = buildConfigFromEnv();
    await saveConfig(config);
    await generateDefaultYaml(config);
    info("Config generated from environment (non-interactive mode)");
    return config;
  }

  // ── Interactive wizard ───────────────────────────────────────────────

  const rl = createRL();

  try {
    banner("ASTRA", "Zero-Config Setup");

    console.log(`  Welcome! Let's get Astra running. This takes about 30 seconds.`);
    console.log(`  Config will be saved to ${DIM}~/.astra/config.json${RESET}\n`);

    // ── QuickStart vs Advanced ─────────────────────────────────────────
    // QuickStart: provider + API key only, all else defaulted.
    // Advanced: full wizard with extra providers, ports, workspace, etc.

    const useQuickStart = flags.quickstart
      ? true
      : await askYesNo(rl, "Use smart defaults? (Y=QuickStart, n=Advanced setup)", true);

    // ── 1. Pick provider ───────────────────────────────────────────────

    section("Default LLM Provider");
    info("Which provider should Astra use by default?");
    const providerChoice = await askChoice(rl,
      "Select provider:",
      ["Claude (Anthropic) — recommended", "OpenAI", "Grok (x.ai)", "Gemini (Google)", "Ollama (local, no API key)"],
      0,
    );
    const provider = providerChoice.split(" ")[0]!.toLowerCase() as AstraCliConfig["defaultProvider"];

    // ── 2. API key ────────────────────────────────────────────────────

    const apiKeys: Record<string, string> = {};

    if (provider !== "ollama") {
      section("API Key");
      const envKey = PROVIDER_KEY_MAP[provider]!;
      info(`Paste your ${envKey} (input is masked)`);
      const key = await askSecret(rl, envKey);
      if (key) apiKeys[envKey] = key;
    }

    // ── Steps 3-6: Advanced mode only ─────────────────────────────────

    let braveApiKey: string | undefined;
    let gatewayPort = 8080;
    let pgPort = 5433;
    let typesensePort = 8108;
    let workspaceName: string | undefined;

    if (!useQuickStart) {
      // ── 3. Additional provider keys ─────────────────────────────────

      section("Additional Providers (optional)");
      info("Add extra providers for fallback or multi-model routing.");
      const addMore = await askYesNo(rl, "Add another API key?", false);
      if (addMore) {
        const remaining = Object.entries(PROVIDER_KEY_MAP).filter(([p]) => p !== provider);
        for (const [p, envKey] of remaining) {
          const wantKey = await askYesNo(rl, `Add ${p} key (${envKey})?`, false);
          if (wantKey) {
            const key = await askSecret(rl, envKey);
            if (key) apiKeys[envKey] = key;
          }
        }
      }

      // ── 4. Brave Search ──────────────────────────────────────────────

      const wantBrave = await askYesNo(rl, "Add Brave Search API key? (enables web search)", false);
      if (wantBrave) {
        braveApiKey = await askSecret(rl, "BRAVE_API_KEY") || undefined;
      }

      // ── 5. Ports ──────────────────────────────────────────────────────

      section("Ports");
      info("Defaults work for most setups. Change only if ports conflict.");
      const customPorts = await askYesNo(rl, "Customize ports?", false);

      if (customPorts) {
        gatewayPort = parseInt(await ask(rl, "Gateway port", "8080"), 10) || 8080;
        pgPort = parseInt(await ask(rl, "PostgreSQL port", "5433"), 10) || 5433;
        typesensePort = parseInt(await ask(rl, "Typesense port", "8108"), 10) || 8108;
      }

      // ── 6. Team Workspace ─────────────────────────────────────────────

      section("Team Workspace (optional)");
      info("Create a shared workspace for your team.");
      const wantWorkspace = await askYesNo(rl, "Create a team workspace?", false);
      if (wantWorkspace) {
        workspaceName = await ask(rl, "Workspace name", "My Team") || undefined;
      }
    }

    // ── Build and save config ──────────────────────────────────────────

    section("Generating Configuration");

    const secrets = generateSecrets();
    const config: AstraCliConfig = {
      defaultProvider: provider,
      apiKeys,
      ...secrets,
      gatewayPort,
      pgPort,
      typesensePort,
      braveApiKey,
      ollamaBaseUrl: provider === "ollama" ? "http://localhost:11434" : undefined,
      workspaceName,
    };

    await saveConfig(config);
    success("Saved config to ~/.astra/config.json");
    success("Generated JWT secret");
    success("Generated internal API key");
    success("Generated Typesense API key");
    success("Generated PostgreSQL password");

    await generateDefaultYaml(config);

    // ── Post-setup health check ────────────────────────────────────────

    let servicesStarted = false;
    const wantHealthCheck = await askYesNo(rl, "Start Docker services and verify setup now?", true);

    if (wantHealthCheck) {
      const docker = await checkDocker();
      if (!docker.ok) {
        warn(`Docker unavailable: ${docker.error}`);
        warn("Skipping health check. Run 'npx astra start' when Docker is ready.");
      } else {
        section("Starting Services");
        info("Starting PostgreSQL and Typesense...");
        try {
          await startServices(config);
          info("Waiting for services to be ready...");
          await waitForHealthy(config, 60_000);
          success("PostgreSQL is ready");
          success("Typesense is ready");
          servicesStarted = true;
        } catch (err) {
          warn(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
          warn("Check 'docker logs astra-postgres' or 'docker logs astra-typesense'.");
        }
      }
    }

    // ── Done ──────────────────────────────────────────────────────────

    section("Ready");
    if (servicesStarted) {
      console.log(`
  ${GREEN}${BOLD}Astra is configured and services are running!${RESET}

  ${BOLD}Next step:${RESET}
    ${CYAN}npx astra${RESET}          ${DIM}# Launch the gateway${RESET}
    ${CYAN}npx astra chat${RESET}     ${DIM}# Start the CLI agent${RESET}

  ${DIM}Run 'npx astra setup' to reconfigure at any time.${RESET}
`);
    } else {
      console.log(`
  ${GREEN}${BOLD}Astra is configured!${RESET}

  ${BOLD}What happens next when you run 'npx astra':${RESET}
    ${CYAN}1.${RESET} Docker pulls Postgres (pgvector) + Typesense
    ${CYAN}2.${RESET} Containers start and health checks pass
    ${CYAN}3.${RESET} Gateway launches at http://localhost:${gatewayPort}

  ${DIM}Run 'npx astra setup' to reconfigure at any time.${RESET}
`);
    }

    return config;
  } finally {
    rl.close();
  }
}

// ── Default astra.yml ───────────────────────────────────────────────

async function generateDefaultYaml(config: AstraCliConfig): Promise<void> {
  // Check if astra.yml exists in cwd first
  try {
    await access("astra.yml");
    success("Found astra.yml in current directory");
    return;
  } catch {
    // Not in cwd — check ~/.astra/
  }

  try {
    await access(DEFAULT_ASTRA_YML_PATH);
    success("Found astra.yml at ~/.astra/astra.yml");
    return;
  } catch {
    // Generate one
  }

  const model = PROVIDER_MODELS[config.defaultProvider] ?? "claude-sonnet-4-6";

  const workspaceBlock = config.workspaceName
    ? `
workspace:
  name: ${config.workspaceName}
`
    : "";

  const yaml = `# ── Astra Agent Configuration ──
# Generated by npx astra setup
# Edit this file to customize your agent team.

settings:
  defaultAgent: assistant
  defaultProvider: ${config.defaultProvider}
  defaultModel: ${model}
${workspaceBlock}
agents:
  assistant:
    displayName: Astra Assistant
    tier: premium
    model:
      provider: ${config.defaultProvider}
      modelId: ${model}
    systemPrompt: |
      You are Astra, a versatile AI assistant with persistent memory.
      You remember past conversations and can search your memory semantically.
    skills:
      - summarize
      - calculator
    tools:
      allow:
        - memory-write
        - memory-search
        - url-fetch
      deny: []
`;

  await mkdir(ASTRA_HOME, { recursive: true });
  await writeFile(DEFAULT_ASTRA_YML_PATH, yaml, "utf-8");
  success("Generated default astra.yml at ~/.astra/astra.yml");
}
