// ── Standalone Environment Config ───────────────────────────────────
// Lighter requirements than the full gateway: no mandatory Grok key,
// no JWT secret (auto-generated), no INTERNAL_API_KEY.
// Requires at least one inference provider API key.

import { randomUUID } from "node:crypto";

export interface StandaloneEnv {
  // Inference — at least one required (cloud key OR local provider)
  anthropicApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  geminiApiKey?: string;

  // Which provider/model to use by default
  defaultProvider: "claude" | "openai" | "grok" | "gemini" | "ollama" | "vllm";
  defaultModel: string;

  // PostgreSQL
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgMaxConnections: number;

  // Typesense (optional — degrades gracefully)
  typesenseApiKey?: string;
  typesenseHost: string;
  typesensePort: number;
  typesenseProtocol: string;

  // Auto-generated for internal use
  jwtSecret: string;
  internalApiKey: string;

  // Skills API keys (optional)
  braveApiKey?: string;
  resendApiKey?: string;
}

function detectProvider(env: NodeJS.ProcessEnv): { provider: StandaloneEnv["defaultProvider"]; model: string } {
  // Cloud providers
  if (env.ANTHROPIC_API_KEY) return { provider: "claude", model: "claude-sonnet-4-6" };
  if (env.OPENAI_API_KEY) return { provider: "openai", model: "gpt-4o" };
  if (env.GROK_API_KEY) return { provider: "grok", model: "grok-3-mini" };
  if (env.GEMINI_API_KEY) return { provider: "gemini", model: "gemini-2.5-flash" };

  // Local providers — no API key needed
  if (env.OLLAMA_BASE_URL || env.STANDALONE_PROVIDER === "ollama") {
    return { provider: "ollama", model: env.OLLAMA_MODEL ?? "qwen3.5" };
  }
  if (env.VLLM_ENDPOINT || env.STANDALONE_PROVIDER === "vllm") {
    return { provider: "vllm", model: env.VLLM_MODEL ?? "default" };
  }

  throw new Error(
    "At least one inference provider is required.\n" +
    "Cloud: set ANTHROPIC_API_KEY, OPENAI_API_KEY, GROK_API_KEY, or GEMINI_API_KEY\n" +
    "Local: set OLLAMA_BASE_URL or VLLM_ENDPOINT (no API key needed)",
  );
}

export function loadStandaloneEnv(): StandaloneEnv {
  const detected = detectProvider(process.env);

  // Allow override via STANDALONE_PROVIDER and STANDALONE_MODEL
  const provider = (process.env.STANDALONE_PROVIDER as StandaloneEnv["defaultProvider"]) || detected.provider;
  const model = process.env.STANDALONE_MODEL || detected.model;

  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    grokApiKey: process.env.GROK_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,

    defaultProvider: provider,
    defaultModel: model,

    pgHost: process.env.PG_HOST || "localhost",
    pgPort: parseInt(process.env.PG_PORT || "5432", 10),
    pgDatabase: process.env.PG_DATABASE || "astra",
    pgUser: process.env.PG_USER || "postgres",
    pgPassword: process.env.PG_PASSWORD || "",
    pgMaxConnections: parseInt(process.env.PG_MAX_CONNECTIONS || "5", 10),

    typesenseApiKey: process.env.TYPESENSE_API_KEY || undefined,
    typesenseHost: process.env.TYPESENSE_HOST || "localhost",
    typesensePort: parseInt(process.env.TYPESENSE_PORT || "8108", 10),
    typesenseProtocol: process.env.TYPESENSE_PROTOCOL || "http",

    // Auto-generate secrets for standalone (never leave the process)
    jwtSecret: process.env.JWT_SECRET || randomUUID(),
    internalApiKey: process.env.INTERNAL_API_KEY || randomUUID(),

    braveApiKey: process.env.BRAVE_API_KEY || undefined,
    resendApiKey: process.env.RESEND_API_KEY || undefined,
  };
}
