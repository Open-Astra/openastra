// ── Environment Config ──────────────────────────────────────────────
// Single source of truth for environment variables.
// Validated with Zod at startup — fails fast on invalid config.

import { z } from "zod";

// ── Known Placeholder Secrets ──────────────────────────────────────
// Reject these in production — they ship in deploy specs and must be
// replaced before going live.

const PLACEHOLDER_SECRETS = new Set([
  "CHANGE_ME_AFTER_DEPLOY",
  "changeme",
  "change_me",
  "your-secret-here",
  "replace-me",
  "TODO",
  "FIXME",
  "secret",
  "password",
]);

function rejectPlaceholder(val: string | undefined, field: string): void {
  if (val && PLACEHOLDER_SECRETS.has(val.trim().toLowerCase())) {
    throw new Error(
      `[SECURITY] ${field} contains a placeholder value ("${val}"). ` +
      `Set a real secret before running in production.`,
    );
  }
}

// ── Zod Helpers ────────────────────────────────────────────────────

/** Coerce a string env var to an integer port with bounds checking. */
function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port number: "${v}" (must be 1–65535)`);
  }
  return n;
}

/** String-to-port schema: default string → parse to validated int. */
const portStr = (fallback: string) =>
  z.string().optional().default(fallback).transform(parsePort);

/** Optional non-empty string — empty string becomes undefined. */
const optStr = z.string().optional().transform((v: string | undefined) => v || undefined);

/** Coerce string to boolean (only "true" is truthy). */
const boolStr = z.string().optional().transform((v: string | undefined) => v === "true");

// ── Environment Schema ─────────────────────────────────────────────

const EnvSchema = z.object({
  // Server
  PORT: portStr("8080"),
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),

  // JWT Auth
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_ACCESS_EXPIRES: z.string().optional().default("15m"),
  JWT_REFRESH_EXPIRES: z.string().optional().default("7d"),

  // Typesense
  TYPESENSE_API_KEY: z.string().min(1, "TYPESENSE_API_KEY is required"),
  TYPESENSE_HOST: z.string().optional().default("localhost"),
  TYPESENSE_PORT: portStr("8108"),
  TYPESENSE_PROTOCOL: z.enum(["http", "https"]).optional().default("http"),

  // Gemini (optional — local embeddings used as fallback)
  GEMINI_API_KEY: optStr,
  EMBEDDING_PROVIDER: z.enum(["gemini", "local"]).optional(),

  // Internal API key for autonomous agent endpoints
  INTERNAL_API_KEY: z.string().min(1, "INTERNAL_API_KEY is required"),

  // Inference providers (at least one required — validated below)
  GROK_API_KEY: optStr,
  GROQ_API_KEY: optStr,
  OPENAI_API_KEY: optStr,
  ANTHROPIC_API_KEY: optStr,
  OPENROUTER_API_KEY: optStr,
  MISTRAL_API_KEY: optStr,
  OLLAMA_BASE_URL: optStr,
  AWS_ACCESS_KEY_ID: optStr,
  AWS_SECRET_ACCESS_KEY: optStr,
  AWS_REGION: optStr,

  // X/Twitter
  X_BEARER_TOKEN: optStr,
  X_API_KEY: optStr,
  X_API_SECRET: optStr,
  X_ACCESS_TOKEN: optStr,
  X_ACCESS_TOKEN_SECRET: optStr,
  X_WEBHOOK_ENV: optStr,

  // LINE
  LINE_CHANNEL_ACCESS_TOKEN: optStr,
  LINE_CHANNEL_SECRET: optStr,

  // Viber
  VIBER_AUTH_TOKEN: optStr,
  VIBER_BOT_NAME: optStr,

  // Channels
  TELEGRAM_BOT_TOKEN: optStr,
  BLUEBUBBLES_URL: optStr,
  BLUEBUBBLES_PASSWORD: optStr,
  WHATSAPP_PHONE_NUMBER_ID: optStr,
  WHATSAPP_ACCESS_TOKEN: optStr,
  WHATSAPP_VERIFY_TOKEN: optStr,
  SIGNAL_API_URL: optStr,
  SIGNAL_PHONE_NUMBER: optStr,
  DISCORD_BOT_TOKEN: optStr,
  SLACK_BOT_TOKEN: optStr,
  SLACK_SIGNING_SECRET: optStr,
  GOOGLE_CHAT_SERVICE_ACCOUNT_KEY: optStr,
  GOOGLE_CHAT_ENABLED: boolStr,

  // Microsoft Teams
  TEAMS_APP_ID: optStr,
  TEAMS_APP_PASSWORD: optStr,

  // Linear
  LINEAR_WEBHOOK_SECRET: optStr,
  LINEAR_API_KEY: optStr,

  // Email (SMTP outbound + Postmark inbound webhook)
  SMTP_HOST: optStr,
  SMTP_PORT: z.string().optional().default("587").transform((v: string) => parseInt(v, 10)),
  SMTP_USER: optStr,
  SMTP_PASSWORD: optStr,
  SMTP_FROM: optStr,
  SMTP_SECURE: boolStr,
  EMAIL_WEBHOOK_SECRET: optStr,

  // Gateway
  GATEWAY_URL: optStr,
  DEFAULT_AGENT_ID: optStr,
  ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),

  // gRPC
  GRPC_PORT: portStr("50051"),
  GRPC_ENABLED: boolStr,
  GRPC_SPAWN_ADDRESS: optStr,

  // PostgreSQL
  PG_HOST: z.string().optional().default("localhost"),
  PG_PORT: portStr("5432"),
  PG_DATABASE: z.string().optional().default("astra"),
  PG_USER: z.string().optional().default("postgres"),
  PG_PASSWORD: z.string().optional().default(""),
  PG_USE_SOCKET: boolStr,
  PG_INSTANCE_CONNECTION_NAME: optStr,
  PG_MAX_CONNECTIONS: z.string().optional().default("10").transform((v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`Invalid PG_MAX_CONNECTIONS: "${v}"`);
    return n;
  }),

  // Skills
  BRAVE_API_KEY: optStr,
  RESEND_API_KEY: optStr,
  ODDS_API_KEY: optStr,

  // Sanity CMS
  SANITY_PROJECT_ID: optStr,
  SANITY_API_TOKEN: optStr,
  SANITY_DATASET: z.string().optional().default("production"),
  SANITY_AUTHOR_REF: optStr,

  // Vault / Secret Backend
  SECRET_BACKEND: z.enum(["vault", "aws-asm", "env"]).optional().default("env"),
  VAULT_ADDR: optStr,
  VAULT_TOKEN: optStr,
  SECRET_TTL_SECONDS: z.string().optional().default("300").transform((v) => parseInt(v, 10)),

  // gRPC mTLS certs (file paths)
  GRPC_TLS_CERT: optStr,
  GRPC_TLS_KEY: optStr,
  GRPC_TLS_CA: optStr,

  // JWT device binding
  BIND_JWT_TO_DEVICE: boolStr,
  JWT_SECRET_PREV: optStr,

  // Memory
  MEMORY_TTL_DAYS: z.string().optional().default("90").transform((v) => parseInt(v, 10)),
  SEMANTIC_CACHE_ENABLED: boolStr,
  MEMORY_BACKEND_TIMEOUT_MS: z.string().optional().default("500").transform((v) => parseInt(v, 10)),

  // Inference payload audit
  INFERENCE_PAYLOAD_TTL_DAYS: z.string().optional().default("30").transform((v) => parseInt(v, 10)),

  // Cold storage
  COLD_STORE_BACKEND: z.enum(["s3", "gcs", "local"]).optional(),
  COLD_STORE_BUCKET: optStr,
  COLD_STORE_REGION: optStr,
  COLD_STORE_PREFIX: optStr,

  // SPLADE sparse embeddings
  SPLADE_ENDPOINT: optStr,

  // Cold store encryption key (64 hex chars = 32 bytes for AES-256-GCM)
  COLD_STORE_ENCRYPTION_KEY: optStr,

  // PII detection policy (feature 36)
  PII_DETECTION_POLICY: z.enum(["block", "redact", "allow"]).optional().default("redact"),

  // Code execution sandbox (feature 37)
  CODE_EXEC_SANDBOX: z.enum(["none", "docker", "process"]).optional().default("process"),
  CODE_EXEC_TIMEOUT_MS: z.string().optional().default("10000").transform((v) => parseInt(v, 10)),
  CODE_EXEC_MEMORY_LIMIT_MB: z.string().optional().default("128").transform((v) => parseInt(v, 10)),
  CODE_EXEC_DOCKER_IMAGE: z.string().optional().default("node:20-alpine"),

  // Per-user rate limiting (feature 38)
  USER_RATE_LIMIT_RPM: z.string().optional().default("60").transform((v) => parseInt(v, 10)),
  USER_RATE_LIMIT_BURST: z.string().optional().default("10").transform((v) => parseInt(v, 10)),

  // Outbound request allowlisting (SSRF hardening)
  ALLOWED_OUTBOUND_HOSTS: optStr,

  // Internal API key rotation (zero-downtime, same pattern as JWT_SECRET_PREV)
  INTERNAL_API_KEY_PREV: optStr,

  // Security alerting webhook (receives critical/high severity events)
  SECURITY_WEBHOOK_URL: optStr,

  // Local development mode
  LOCAL_DEV: boolStr,

  // Feature 31: Prompt injection policy
  PROMPT_INJECTION_POLICY: z.enum(["block", "warn", "allow"]).optional().default("warn"),

  // Feature 33: Session watermarking
  WATERMARK_ENABLED: boolStr,

  // Feature 37: Warm pool (Wave 7)
  WARM_POOL_MODELS: optStr,     // comma-separated "provider:modelId" pairs
  WARM_POOL_SIZE: z.string().optional().default("3").transform((v) => parseInt(v, 10)),

  // Feature 39: Multi-region failover (Wave 7)
  PG_STANDBY_HOST: optStr,
  PG_STANDBY_PORT: portStr("5432"),
  PG_STANDBY_DATABASE: optStr,
  PG_FAILOVER_ENABLED: boolStr,

  // Wave 2 (Developer Tools)
  OTEL_EXPORT_ENABLED: boolStr,

  // Wave 5 (Channels)
  ZAPIER_ENABLED: boolStr,
  JIRA_ENABLED: boolStr,

  // Wave 7 (Observability)
  COST_ANOMALY_THRESHOLD: z.string().optional().default("3").transform((v) => parseFloat(v)),

  // Wave 8 (Infrastructure)
  PG_REPLICA_HOST: optStr,
  PG_REPLICA_PORT: portStr("5432"),
  PG_REPLICA_DATABASE: optStr,
  MESH_GOSSIP_ENABLED: boolStr,

  // Edge / hardware accelerator provider (Feature 5)
  EDGE_INFERENCE_URL: optStr,

  // Latency trend alerting threshold (Feature 10a)
  LATENCY_TREND_ALERT_THRESHOLD: z.string().optional().default("50").transform((v) => parseFloat(v)),

  // Cache features (Wave 9)
  CACHE_INVALIDATION_BUS_ENABLED: boolStr,
  CACHE_COMPRESSION_ENABLED: boolStr,
  CACHE_COMPRESSION_THRESHOLD_BYTES: z.string().optional().default("1024").transform((v) => parseInt(v, 10)),

  // Features 1–7: Cache Warming, Streaming, Coalescing, Token Prediction, Batching, Extended Thinking
  ML_CACHE_WARMING_ENABLED: boolStr,
  CACHE_STREAMING_ENABLED: boolStr,
  REQUEST_COALESCING_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  TOKEN_PREDICTION_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  ADAPTIVE_BATCHING_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  EXTENDED_THINKING_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),

});

// ── Parsed Config Interface ────────────────────────────────────────

export interface EnvConfig {
  port: number;
  grokApiKey?: string;
  nodeEnv: string;

  // JWT Auth
  jwtSecret: string;
  jwtAccessExpires: string;
  jwtRefreshExpires: string;

  // Typesense
  typesenseApiKey: string;
  typesenseHost: string;
  typesensePort: number;
  typesenseProtocol: string;

  // Gemini (for embeddings — optional, falls back to local embeddings)
  geminiApiKey?: string;

  // Embedding provider: "gemini" | "local" (auto-detected if not set)
  embeddingProvider?: string;

  // Internal API key for autonomous agent endpoints
  internalApiKey: string;

  // X/Twitter API bearer token for search (falls back to grokApiKey)
  xBearerToken: string;

  // Groq API key (ultra-fast LPU inference)
  groqApiKey?: string;

  // OpenAI API key (fallback inference provider)
  openaiApiKey?: string;

  // Anthropic API key (Claude inference provider)
  anthropicApiKey?: string;

  // OpenRouter
  openrouterApiKey?: string;

  // Mistral AI
  mistralApiKey?: string;

  // AWS Bedrock
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;

  // Telegram bot
  telegramBotToken?: string;

  // iMessage (BlueBubbles)
  blueBubblesUrl?: string;
  blueBubblesPassword?: string;

  // WhatsApp (Meta Cloud API)
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  whatsappVerifyToken?: string;

  // Signal (signal-cli REST API)
  signalApiUrl?: string;
  signalPhoneNumber?: string;

  // Discord
  discordBotToken?: string;

  // Slack
  slackBotToken?: string;
  slackSigningSecret?: string;

  // Google Chat
  googleChatServiceAccountKey?: string;
  googleChatEnabled?: boolean;

  // Microsoft Teams
  teamsAppId?: string;
  teamsAppPassword?: string;

  // X/Twitter DMs (OAuth 1.0a)
  xApiKey?: string;
  xApiSecret?: string;
  xAccessToken?: string;
  xAccessTokenSecret?: string;
  xWebhookEnv?: string;

  // LINE
  lineChannelAccessToken?: string;
  lineChannelSecret?: string;

  // Viber
  viberAuthToken?: string;
  viberBotName?: string;

  // Linear
  linearWebhookSecret?: string;
  linearApiKey?: string;

  // Email (SMTP outbound + Postmark inbound webhook)
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  smtpSecure?: boolean;
  emailWebhookSecret?: string;

  // Gateway URL (for webhook registration)
  gatewayUrl?: string;

  // Default agent ID for channels
  defaultAgentId?: string;

  // CORS
  allowedOrigins: string[];

  // gRPC internal transport
  grpcPort: number;
  grpcEnabled: boolean;
  grpcSpawnAddress?: string;

  // Cloud SQL PostgreSQL
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgUseSocket: boolean;
  pgInstanceConnectionName?: string;
  pgMaxConnections: number;

  // Skills — optional API keys
  braveApiKey?: string;
  resendApiKey?: string;

  // Sanity CMS
  sanityProjectId?: string;
  sanityApiToken?: string;
  sanityDataset: string;
  sanityAuthorRef?: string;

  // Vault / Secret Backend
  secretBackend: "vault" | "aws-asm" | "env";
  vaultAddr?: string;
  vaultToken?: string;
  secretTtlSeconds: number;

  // gRPC mTLS certs (file paths)
  grpcTlsCert?: string;
  grpcTlsKey?: string;
  grpcTlsCa?: string;

  // JWT device binding
  bindJwtToDevice: boolean;
  jwtSecretPrev?: string;

  // Memory
  memoryTtlDays: number;
  semanticCacheEnabled: boolean;
  memoryBackendTimeoutMs: number;

  // Inference payload audit
  inferencePayloadTtlDays: number;

  // Cold storage
  coldStoreBackend?: "s3" | "gcs" | "local";
  coldStoreBucket?: string;
  coldStoreRegion?: string;
  coldStorePrefix?: string;
  coldStoreEncryptionKey?: string;

  // SPLADE sparse embeddings
  spladeEndpoint?: string;

  // PII detection (feature 36)
  piiDetectionPolicy: "block" | "redact" | "allow";

  // Code execution sandbox (feature 37)
  codeExecSandbox: "none" | "docker" | "process";
  codeExecTimeoutMs: number;
  codeExecMemoryLimitMb: number;
  codeExecDockerImage: string;

  // Per-user rate limiting (feature 38)
  userRateLimitRpm: number;
  userRateLimitBurst: number;

  // Outbound request allowlisting (SSRF hardening)
  allowedOutboundHosts?: string;

  // Internal API key rotation
  internalApiKeyPrev?: string;

  // Security alerting webhook
  securityWebhookUrl?: string;

  // Local development mode
  localDev: boolean;

  // Prompt injection policy (Feature 31)
  promptInjectionPolicy: "block" | "warn" | "allow";

  // Watermarking (Feature 33)
  watermarkEnabled: boolean;

  // Warm pool (Wave 7)
  warmPoolModels?: string;
  warmPoolSize: number;

  // Multi-region failover (Wave 7)
  pgStandbyHost?: string;
  pgStandbyPort: number;
  pgStandbyDatabase?: string;
  pgFailoverEnabled: boolean;

  // Wave 2 (Developer Tools)
  otelExportEnabled: boolean;

  // Wave 5 (Channels)
  zapierEnabled: boolean;
  jiraEnabled: boolean;

  // Wave 7 (Observability)
  costAnomalyThreshold: number;

  // Latency trend alerting (Feature 10a)
  latencyTrendAlertThreshold: number;

  // Wave 8 (Infrastructure)
  pgReplicaHost?: string;
  pgReplicaPort: number;
  pgReplicaDatabase?: string;
  meshGossipEnabled: boolean;

  // Edge / hardware accelerator provider (Feature 5)
  edgeInferenceUrl?: string;

  // Cache features (Wave 9)
  cacheInvalidationBusEnabled: boolean;
  cacheCompressionEnabled: boolean;
  cacheCompressionThresholdBytes: number;

  // Features 1–7: Cache Warming, Streaming, Coalescing, Token Prediction, Batching, Extended Thinking
  mlCacheWarmingEnabled: boolean;
  cacheStreamingEnabled: boolean;
  requestCoalescingEnabled: boolean;
  tokenPredictionEnabled: boolean;
  adaptiveBatchingEnabled: boolean;
  extendedThinkingEnabled: boolean;
}

export function loadEnv(): EnvConfig {
  // Parse and validate all env vars through Zod
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: any) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const e = parsed.data;

  // At least one inference provider key is required
  const hasProvider = e.GROK_API_KEY
    || e.GROQ_API_KEY
    || e.ANTHROPIC_API_KEY
    || e.OPENAI_API_KEY
    || e.GEMINI_API_KEY
    || e.OLLAMA_BASE_URL
    || e.OPENROUTER_API_KEY
    || e.MISTRAL_API_KEY
    || e.AWS_ACCESS_KEY_ID;
  if (!hasProvider) {
    throw new Error(
      "At least one inference provider key is required.\n" +
      "Set one of: GROK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL",
    );
  }

  // In production, reject placeholder secrets and validate security config
  if (e.NODE_ENV === "production") {
    rejectPlaceholder(e.JWT_SECRET, "JWT_SECRET");
    rejectPlaceholder(e.INTERNAL_API_KEY, "INTERNAL_API_KEY");
    rejectPlaceholder(e.TYPESENSE_API_KEY, "TYPESENSE_API_KEY");
    rejectPlaceholder(e.PG_PASSWORD, "PG_PASSWORD");

    // JWT_SECRET should be at least 32 chars for HS256
    if (e.JWT_SECRET.length < 32) {
      throw new Error(
        `[SECURITY] JWT_SECRET is only ${e.JWT_SECRET.length} characters. ` +
        `Use at least 32 characters for HS256 signing.`,
      );
    }

    // CORS wildcard is dangerous in production
    if (e.ALLOWED_ORIGINS === "*") {
      throw new Error(
        `[SECURITY] ALLOWED_ORIGINS is set to "*" in production. ` +
        `Restrict to specific origins.`,
      );
    }

    // CODE_EXEC_SANDBOX=none is not safe for production
    if (e.CODE_EXEC_SANDBOX === "none") {
      throw new Error(
        `[SECURITY] CODE_EXEC_SANDBOX is "none" in production. ` +
        `Use "process" or "docker" for sandboxed code execution.`,
      );
    }

    // Warnings (non-fatal but logged)
    const warnings: string[] = [];
    if (!e.BIND_JWT_TO_DEVICE) {
      warnings.push("BIND_JWT_TO_DEVICE is not enabled — tokens are not tied to devices");
    }
    if (e.SECRET_BACKEND === "env") {
      warnings.push("SECRET_BACKEND is 'env' — consider using Vault or AWS ASM for production");
    }
    if (e.PII_DETECTION_POLICY === "allow") {
      warnings.push("PII_DETECTION_POLICY is 'allow' — PII may be stored in memory");
    }
    if (!e.COLD_STORE_ENCRYPTION_KEY) {
      warnings.push("COLD_STORE_ENCRYPTION_KEY is not set — cold store snapshots will be unencrypted");
    }
    if (warnings.length > 0) {
      console.warn(`[SECURITY] Production configuration warnings:\n  - ${warnings.join("\n  - ")}`);
    }
  }

  // Parse ALLOWED_ORIGINS as comma-separated list
  const allowedOrigins = e.ALLOWED_ORIGINS.split(",").map((o: string) => o.trim()).filter(Boolean);

  return {
    port: e.PORT,
    grokApiKey: e.GROK_API_KEY,
    nodeEnv: e.NODE_ENV,

    // JWT
    jwtSecret: e.JWT_SECRET,
    jwtAccessExpires: e.JWT_ACCESS_EXPIRES,
    jwtRefreshExpires: e.JWT_REFRESH_EXPIRES,

    typesenseApiKey: e.TYPESENSE_API_KEY,
    typesenseHost: e.TYPESENSE_HOST,
    typesensePort: e.TYPESENSE_PORT,
    typesenseProtocol: e.TYPESENSE_PROTOCOL,

    geminiApiKey: e.GEMINI_API_KEY,
    embeddingProvider: e.EMBEDDING_PROVIDER,
    internalApiKey: e.INTERNAL_API_KEY,

    xBearerToken: e.X_BEARER_TOKEN || e.GROK_API_KEY || "",
    groqApiKey: e.GROQ_API_KEY,
    openaiApiKey: e.OPENAI_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    openrouterApiKey: e.OPENROUTER_API_KEY,
    mistralApiKey: e.MISTRAL_API_KEY,
    awsAccessKeyId: e.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    awsRegion: e.AWS_REGION,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    blueBubblesUrl: e.BLUEBUBBLES_URL,
    blueBubblesPassword: e.BLUEBUBBLES_PASSWORD,
    whatsappPhoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    whatsappAccessToken: e.WHATSAPP_ACCESS_TOKEN,
    whatsappVerifyToken: e.WHATSAPP_VERIFY_TOKEN,
    signalApiUrl: e.SIGNAL_API_URL,
    signalPhoneNumber: e.SIGNAL_PHONE_NUMBER,
    discordBotToken: e.DISCORD_BOT_TOKEN,
    slackBotToken: e.SLACK_BOT_TOKEN,
    slackSigningSecret: e.SLACK_SIGNING_SECRET,
    googleChatServiceAccountKey: e.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY,
    googleChatEnabled: e.GOOGLE_CHAT_ENABLED,
    teamsAppId: e.TEAMS_APP_ID,
    teamsAppPassword: e.TEAMS_APP_PASSWORD,
    xApiKey: e.X_API_KEY,
    xApiSecret: e.X_API_SECRET,
    xAccessToken: e.X_ACCESS_TOKEN,
    xAccessTokenSecret: e.X_ACCESS_TOKEN_SECRET,
    xWebhookEnv: e.X_WEBHOOK_ENV,
    lineChannelAccessToken: e.LINE_CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: e.LINE_CHANNEL_SECRET,
    viberAuthToken: e.VIBER_AUTH_TOKEN,
    viberBotName: e.VIBER_BOT_NAME,
    linearWebhookSecret: e.LINEAR_WEBHOOK_SECRET,
    linearApiKey: e.LINEAR_API_KEY,
    smtpHost: e.SMTP_HOST,
    smtpPort: e.SMTP_PORT,
    smtpUser: e.SMTP_USER,
    smtpPassword: e.SMTP_PASSWORD,
    smtpFrom: e.SMTP_FROM,
    smtpSecure: e.SMTP_SECURE,
    emailWebhookSecret: e.EMAIL_WEBHOOK_SECRET,
    gatewayUrl: e.GATEWAY_URL,
    defaultAgentId: e.DEFAULT_AGENT_ID,
    allowedOrigins,

    // gRPC internal transport
    grpcPort: e.GRPC_PORT,
    grpcEnabled: e.GRPC_ENABLED,
    grpcSpawnAddress: e.GRPC_SPAWN_ADDRESS,

    // Cloud SQL PostgreSQL
    pgHost: e.PG_HOST,
    pgPort: e.PG_PORT,
    pgDatabase: e.PG_DATABASE,
    pgUser: e.PG_USER,
    pgPassword: e.PG_PASSWORD,
    pgUseSocket: e.PG_USE_SOCKET,
    pgInstanceConnectionName: e.PG_INSTANCE_CONNECTION_NAME,
    pgMaxConnections: e.PG_MAX_CONNECTIONS,

    // Skills
    braveApiKey: e.BRAVE_API_KEY,
    resendApiKey: e.RESEND_API_KEY,

    // Sanity CMS
    sanityProjectId: e.SANITY_PROJECT_ID,
    sanityApiToken: e.SANITY_API_TOKEN,
    sanityDataset: e.SANITY_DATASET,
    sanityAuthorRef: e.SANITY_AUTHOR_REF,

    // Vault / Secret Backend
    secretBackend: e.SECRET_BACKEND,
    vaultAddr: e.VAULT_ADDR,
    vaultToken: e.VAULT_TOKEN,
    secretTtlSeconds: e.SECRET_TTL_SECONDS,

    // gRPC mTLS certs
    grpcTlsCert: e.GRPC_TLS_CERT,
    grpcTlsKey: e.GRPC_TLS_KEY,
    grpcTlsCa: e.GRPC_TLS_CA,

    // JWT device binding
    bindJwtToDevice: e.BIND_JWT_TO_DEVICE,
    jwtSecretPrev: e.JWT_SECRET_PREV,

    // Memory
    memoryTtlDays: e.MEMORY_TTL_DAYS,
    semanticCacheEnabled: e.SEMANTIC_CACHE_ENABLED,
    memoryBackendTimeoutMs: e.MEMORY_BACKEND_TIMEOUT_MS,

    // Inference payload audit
    inferencePayloadTtlDays: e.INFERENCE_PAYLOAD_TTL_DAYS,

    // Cold storage
    coldStoreBackend: e.COLD_STORE_BACKEND,
    coldStoreBucket: e.COLD_STORE_BUCKET,
    coldStoreRegion: e.COLD_STORE_REGION,
    coldStorePrefix: e.COLD_STORE_PREFIX,
    coldStoreEncryptionKey: e.COLD_STORE_ENCRYPTION_KEY,

    // SPLADE sparse embeddings
    spladeEndpoint: e.SPLADE_ENDPOINT,

    piiDetectionPolicy: e.PII_DETECTION_POLICY,
    codeExecSandbox: e.CODE_EXEC_SANDBOX,
    codeExecTimeoutMs: e.CODE_EXEC_TIMEOUT_MS,
    codeExecMemoryLimitMb: e.CODE_EXEC_MEMORY_LIMIT_MB,
    codeExecDockerImage: e.CODE_EXEC_DOCKER_IMAGE,
    userRateLimitRpm: e.USER_RATE_LIMIT_RPM,
    userRateLimitBurst: e.USER_RATE_LIMIT_BURST,
    allowedOutboundHosts: e.ALLOWED_OUTBOUND_HOSTS,
    internalApiKeyPrev: e.INTERNAL_API_KEY_PREV,
    securityWebhookUrl: e.SECURITY_WEBHOOK_URL,
    localDev: e.LOCAL_DEV,
    promptInjectionPolicy: e.PROMPT_INJECTION_POLICY,
    watermarkEnabled: e.WATERMARK_ENABLED,
    warmPoolModels: e.WARM_POOL_MODELS,
    warmPoolSize: e.WARM_POOL_SIZE,
    pgStandbyHost: e.PG_STANDBY_HOST,
    pgStandbyPort: e.PG_STANDBY_PORT,
    pgStandbyDatabase: e.PG_STANDBY_DATABASE,
    pgFailoverEnabled: e.PG_FAILOVER_ENABLED,

    // Wave 2 (Developer Tools)
    otelExportEnabled: e.OTEL_EXPORT_ENABLED,

    // Wave 5 (Channels)
    zapierEnabled: e.ZAPIER_ENABLED,
    jiraEnabled: e.JIRA_ENABLED,

    // Wave 7 (Observability)
    costAnomalyThreshold: e.COST_ANOMALY_THRESHOLD,

    // Latency trend alerting (Feature 10a)
    latencyTrendAlertThreshold: e.LATENCY_TREND_ALERT_THRESHOLD,

    // Wave 8 (Infrastructure)
    pgReplicaHost: e.PG_REPLICA_HOST,
    pgReplicaPort: e.PG_REPLICA_PORT,
    pgReplicaDatabase: e.PG_REPLICA_DATABASE,
    meshGossipEnabled: e.MESH_GOSSIP_ENABLED,

    // Edge / hardware accelerator provider (Feature 5)
    edgeInferenceUrl: e.EDGE_INFERENCE_URL,

    // Cache features (Wave 9)
    cacheInvalidationBusEnabled: e.CACHE_INVALIDATION_BUS_ENABLED,
    cacheCompressionEnabled: e.CACHE_COMPRESSION_ENABLED,
    cacheCompressionThresholdBytes: e.CACHE_COMPRESSION_THRESHOLD_BYTES,

    // Features 1–7: Cache Warming, Streaming, Coalescing, Token Prediction, Batching, Extended Thinking
    mlCacheWarmingEnabled: e.ML_CACHE_WARMING_ENABLED,
    cacheStreamingEnabled: e.CACHE_STREAMING_ENABLED,
    requestCoalescingEnabled: e.REQUEST_COALESCING_ENABLED,
    tokenPredictionEnabled: e.TOKEN_PREDICTION_ENABLED,
    adaptiveBatchingEnabled: e.ADAPTIVE_BATCHING_ENABLED,
    extendedThinkingEnabled: e.EXTENDED_THINKING_ENABLED,
  };
}
