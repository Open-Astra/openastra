// ── CLI Config Persistence ──────────────────────────────────────────
// Stores Astra CLI configuration at ~/.astra/config.json.
// Generated secrets persist across runs so Docker volumes stay valid.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Paths ───────────────────────────────────────────────────────────

export const ASTRA_HOME = join(homedir(), ".astra");
export const CONFIG_PATH = join(ASTRA_HOME, "config.json");
export const DEFAULT_ASTRA_YML_PATH = join(ASTRA_HOME, "astra.yml");

// ── Config Shape ────────────────────────────────────────────────────

export interface AstraCliConfig {
  // Inference
  defaultProvider: "claude" | "openai" | "grok" | "gemini" | "ollama";
  apiKeys: Record<string, string>; // e.g. { ANTHROPIC_API_KEY: "sk-..." }

  // Auto-generated secrets
  jwtSecret: string;
  internalApiKey: string;
  typesenseApiKey: string;
  pgPassword: string;

  // Ports (defaults: gateway 8080, postgres 5433, typesense 8108)
  gatewayPort: number;
  pgPort: number;
  typesensePort: number;

  // Optional extras
  braveApiKey?: string;
  ollamaBaseUrl?: string;
  workspaceName?: string;
}

// ── Secret Generation ───────────────────────────────────────────────

export function generateSecrets(): Pick<AstraCliConfig, "jwtSecret" | "internalApiKey" | "typesenseApiKey" | "pgPassword"> {
  return {
    jwtSecret: randomBytes(32).toString("hex"),
    internalApiKey: randomBytes(24).toString("hex"),
    typesenseApiKey: randomBytes(24).toString("hex"),
    pgPassword: randomBytes(16).toString("hex"),
  };
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function configExists(): Promise<boolean> {
  try {
    await readFile(CONFIG_PATH, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<AstraCliConfig> {
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as AstraCliConfig;
}

export async function saveConfig(config: AstraCliConfig): Promise<void> {
  await mkdir(ASTRA_HOME, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function deleteConfig(): Promise<void> {
  try {
    await rm(ASTRA_HOME, { recursive: true, force: true });
  } catch {
    // Already gone
  }
}

// ── Environment Injection ───────────────────────────────────────────
// Maps saved config fields → process.env so loadEnv() works unchanged.

export function injectEnv(config: AstraCliConfig): void {
  const set = (key: string, value: string | undefined) => {
    if (value) process.env[key] = value;
  };

  // Secrets
  set("JWT_SECRET", config.jwtSecret);
  set("INTERNAL_API_KEY", config.internalApiKey);
  set("TYPESENSE_API_KEY", config.typesenseApiKey);

  // Typesense — always localhost for Docker-managed containers
  set("TYPESENSE_HOST", "localhost");
  set("TYPESENSE_PORT", String(config.typesensePort));
  set("TYPESENSE_PROTOCOL", "http");

  // PostgreSQL
  set("PG_HOST", "localhost");
  set("PG_PORT", String(config.pgPort));
  set("PG_DATABASE", "astra");
  set("PG_USER", "astra");
  set("PG_PASSWORD", config.pgPassword);

  // Gateway port
  set("PORT", String(config.gatewayPort));

  // Provider API keys
  for (const [key, value] of Object.entries(config.apiKeys)) {
    set(key, value);
  }

  // Optional keys
  set("BRAVE_API_KEY", config.braveApiKey);
  set("OLLAMA_BASE_URL", config.ollamaBaseUrl);

  // Load .env file as fallback for vars not set by config (e.g. channel tokens)
  loadDotEnvFallback();
}

// ── .env Fallback ──────────────────────────────────────────────────
// Reads .env from cwd and injects vars that aren't already in process.env.
// This lets users add TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, etc. without
// needing them in ~/.astra/config.json.

function loadDotEnvFallback(): void {
  try {
    const content = readFileSync(join(process.cwd(), ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't override vars already set by config
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine
  }
}
