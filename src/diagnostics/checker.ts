import { z } from "zod";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, pingPostgres } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("diagnostics");

// ── Types ──────────────────────────────────────────────────────────

export const DiagnosticStatus = z.enum(["pass", "warn", "fail"]);
export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>;

export const DiagnosticCheck = z.object({
  name: z.string(),
  status: DiagnosticStatus,
  message: z.string(),
  durationMs: z.number(),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;

export const OverallStatus = z.enum(["healthy", "degraded", "unhealthy"]);
export type OverallStatus = z.infer<typeof OverallStatus>;

export const DiagnosticResult = z.object({
  checks: z.array(DiagnosticCheck),
  overallStatus: OverallStatus,
  durationMs: z.number(),
});
export type DiagnosticResult = z.infer<typeof DiagnosticResult>;

// ── Helpers ────────────────────────────────────────────────────────

async function timedCheck(
  name: string,
  fn: () => Promise<{ status: DiagnosticStatus; message: string }>,
): Promise<DiagnosticCheck> {
  const start = performance.now();
  try {
    const { status, message } = await fn();
    return { name, status, message, durationMs: Math.round(performance.now() - start) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: "fail", message, durationMs: Math.round(performance.now() - start) };
  }
}

function deriveOverallStatus(checks: DiagnosticCheck[]): OverallStatus {
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  if (hasFail) return "unhealthy";
  if (hasWarn) return "degraded";
  return "healthy";
}

// ── Provider Key Map ───────────────────────────────────────────────

const PROVIDER_ENV_MAP: Record<string, string> = {
  grok: "GROK_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  ollama: "OLLAMA_BASE_URL",
  vllm: "VLLM_API_KEY",
};

// ── Individual Checks ──────────────────────────────────────────────

async function checkPostgresConnectivity(): Promise<DiagnosticCheck> {
  return timedCheck("postgres-connectivity", async () => {
    const ok = await pingPostgres();
    if (ok) return { status: "pass", message: "PostgreSQL is reachable" };
    return { status: "fail", message: "PostgreSQL ping failed" };
  });
}

async function checkTypesenseConnectivity(): Promise<DiagnosticCheck> {
  return timedCheck("typesense-connectivity", async () => {
    if (!process.env.TYPESENSE_API_KEY) {
      return { status: "warn", message: "TYPESENSE_API_KEY not set — skipped" };
    }

    try {
      const { getTypesense } = await import("../config/typesense.js");
      const ts = getTypesense();
      await ts.health.retrieve();
      return { status: "pass", message: "Typesense is healthy" };
    } catch {
      return { status: "fail", message: "Typesense health check failed — is the service running?" };
    }
  });
}

async function checkOllamaConnectivity(): Promise<DiagnosticCheck> {
  return timedCheck("ollama-connectivity", async () => {
    const baseUrl = process.env.OLLAMA_BASE_URL;
    if (!baseUrl) {
      return { status: "warn", message: "OLLAMA_BASE_URL not set — skipped" };
    }

    try {
      const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) return { status: "pass", message: `Ollama reachable at ${baseUrl}` };
      return { status: "fail", message: `Ollama returned HTTP ${resp.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "fail", message: `Ollama unreachable at ${baseUrl}: ${msg}` };
    }
  });
}

async function checkRequiredEnvVars(): Promise<DiagnosticCheck> {
  return timedCheck("config-env-vars", async () => {
    const required = ["PG_HOST", "PG_DATABASE", "PG_USER"];
    const missing = required.filter((k) => !process.env[k]);

    if (missing.length > 0) {
      return { status: "warn", message: `Missing env vars: ${missing.join(", ")} (using defaults)` };
    }
    return { status: "pass", message: "All required env vars present" };
  });
}

async function checkProviderKeys(): Promise<DiagnosticCheck> {
  return timedCheck("config-provider-keys", async () => {
    const available = Object.entries(PROVIDER_ENV_MAP)
      .filter(([, envVar]) => !!process.env[envVar])
      .map(([provider]) => provider);

    if (available.length === 0) {
      return { status: "fail", message: "No inference provider API keys configured" };
    }
    return { status: "pass", message: `Providers available: ${available.join(", ")}` };
  });
}

async function checkAstraYml(): Promise<DiagnosticCheck> {
  return timedCheck("config-astra-yml", async () => {
    try {
      const { loadAstraConfig } = await import("../config/yaml-loader.js");
      const config = await loadAstraConfig();
      if (config) {
        return { status: "pass", message: "astra.yml parsed successfully" };
      }
      return { status: "warn", message: "No astra.yml found (using defaults)" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "fail", message: `astra.yml parse error: ${msg}` };
    }
  });
}

async function checkMigrations(): Promise<DiagnosticCheck> {
  return timedCheck("migrations", async () => {
    const pool = getPool();

    // Get applied migrations
    let appliedSet: Set<string>;
    try {
      const { rows } = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      appliedSet = new Set(rows.map((r) => r.version));
    } catch {
      return { status: "fail", message: "schema_migrations table not found — run migrations first" };
    }

    // Read migration files
    const migrationsDir = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "db",
      "migrations",
    );

    let files: string[];
    try {
      files = await readdir(migrationsDir);
    } catch {
      return { status: "warn", message: "Migrations directory not found" };
    }

    const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
    const pending = sqlFiles.filter((f) => !appliedSet.has(f));

    if (pending.length > 0) {
      return {
        status: "warn",
        message: `${pending.length} pending migration(s): ${pending.join(", ")}`,
      };
    }

    return { status: "pass", message: `All ${sqlFiles.length} migrations applied` };
  });
}

async function checkAgents(): Promise<DiagnosticCheck> {
  return timedCheck("agents", async () => {
    const { getAllAgentConfigs } = await import("../config/agents.js");
    const agents = getAllAgentConfigs();

    if (agents.size === 0) {
      return { status: "warn", message: "No agents registered in runtime" };
    }

    // Check that each agent's provider has a configured API key
    const missingKeys: string[] = [];
    for (const [id, config] of agents) {
      const envVar = PROVIDER_ENV_MAP[config.model.provider];
      if (envVar && !process.env[envVar]) {
        missingKeys.push(`${id} (${config.model.provider} needs ${envVar})`);
      }
    }

    if (missingKeys.length > 0) {
      return {
        status: "warn",
        message: `${agents.size} agent(s) registered, but missing keys for: ${missingKeys.join("; ")}`,
      };
    }

    return { status: "pass", message: `${agents.size} agent(s) registered, all providers configured` };
  });
}

async function checkProviderInference(): Promise<DiagnosticCheck> {
  return timedCheck("provider-inference", async () => {
    const results: string[] = [];
    const failures: string[] = [];

    // Test each provider that has credentials configured
    const providers: Array<{
      name: string;
      envVar: string;
      test: () => Promise<void>;
    }> = [];

    if (process.env.ANTHROPIC_API_KEY) {
      providers.push({
        name: "claude",
        envVar: "ANTHROPIC_API_KEY",
        test: async () => {
          const { createClaudeClient } = await import("../inference/claude.js");
          const client = createClaudeClient(process.env.ANTHROPIC_API_KEY!, "claude-sonnet-4-20250514");
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (process.env.OPENAI_API_KEY) {
      providers.push({
        name: "openai",
        envVar: "OPENAI_API_KEY",
        test: async () => {
          const { createOpenAIClient } = await import("../inference/openai.js");
          const client = createOpenAIClient(process.env.OPENAI_API_KEY!, "gpt-4o-mini");
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (process.env.GROK_API_KEY) {
      providers.push({
        name: "grok",
        envVar: "GROK_API_KEY",
        test: async () => {
          const { createGrokClient } = await import("../inference/grok.js");
          const client = createGrokClient(process.env.GROK_API_KEY!, "https://api.x.ai/v1", "grok-3-mini");
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (process.env.GROQ_API_KEY) {
      providers.push({
        name: "groq",
        envVar: "GROQ_API_KEY",
        test: async () => {
          const { createGroqClient } = await import("../inference/groq.js");
          const client = createGroqClient(process.env.GROQ_API_KEY!, "llama-3.1-8b-instant");
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (process.env.GEMINI_API_KEY) {
      providers.push({
        name: "gemini",
        envVar: "GEMINI_API_KEY",
        test: async () => {
          const { createGeminiClient } = await import("../inference/gemini.js");
          const client = createGeminiClient(process.env.GEMINI_API_KEY!, "gemini-2.0-flash");
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (process.env.OLLAMA_BASE_URL) {
      providers.push({
        name: "ollama",
        envVar: "OLLAMA_BASE_URL",
        test: async () => {
          const { createOllamaClient } = await import("../inference/ollama.js");
          // List available models first, then test with the first one
          const baseUrl = process.env.OLLAMA_BASE_URL!;
          const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) throw new Error(`Ollama returned HTTP ${resp.status}`);
          const data = (await resp.json()) as { models?: Array<{ name: string }> };
          const modelName = data.models?.[0]?.name;
          if (!modelName) throw new Error("No models available in Ollama");
          const client = createOllamaClient(baseUrl, modelName);
          await client.chat({
            messages: [{ role: "user", content: "Say OK" }],
            maxTokens: 10,
          });
        },
      });
    }

    if (providers.length === 0) {
      return { status: "warn", message: "No provider credentials configured to test" };
    }

    // Test all providers in parallel
    const providerResults = await Promise.allSettled(
      providers.map(async (p) => {
        try {
          await p.test();
          results.push(p.name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${p.name}: ${msg}`);
        }
      }),
    );

    // Handle unexpected rejections
    for (let i = 0; i < providerResults.length; i++) {
      const r = providerResults[i];
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${providers[i].name}: ${msg}`);
      }
    }

    if (failures.length > 0 && results.length === 0) {
      return { status: "fail", message: `All provider tests failed: ${failures.join("; ")}` };
    }

    if (failures.length > 0) {
      return {
        status: "warn",
        message: `Passed: ${results.join(", ")}. Failed: ${failures.join("; ")}`,
      };
    }

    return { status: "pass", message: `All providers responded: ${results.join(", ")}` };
  });
}

async function checkTypesenseCollection(): Promise<DiagnosticCheck> {
  return timedCheck("memory-typesense-collection", async () => {
    if (!process.env.TYPESENSE_API_KEY) {
      return { status: "warn", message: "TYPESENSE_API_KEY not set — skipped" };
    }

    try {
      const { getTypesense } = await import("../config/typesense.js");
      const ts = getTypesense();
      const collection = await ts.collections("memory_chunks").retrieve();
      return {
        status: "pass",
        message: `memory_chunks collection exists (${collection.num_documents ?? 0} documents)`,
      };
    } catch {
      return { status: "fail", message: "memory_chunks collection not found in Typesense" };
    }
  });
}

async function checkEmbeddingGeneration(): Promise<DiagnosticCheck> {
  return timedCheck("memory-embeddings", async () => {
    try {
      const { generateEmbedding, getEmbeddingProvider } = await import("../memory/embeddings.js");
      const embedding = await generateEmbedding("diagnostic test");
      const provider = getEmbeddingProvider();

      if (!Array.isArray(embedding) || embedding.length === 0) {
        return { status: "fail", message: "Embedding generation returned empty result" };
      }

      return {
        status: "pass",
        message: `Embedding OK (${provider}, ${embedding.length}-dim)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "fail", message: `Embedding generation failed: ${msg}` };
    }
  });
}

async function checkPgvectorExtension(): Promise<DiagnosticCheck> {
  return timedCheck("memory-pgvector", async () => {
    const pool = getPool();
    try {
      const { rows } = await pool.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      if (rows.length > 0) {
        return { status: "pass", message: "pgvector extension is loaded" };
      }
      return { status: "warn", message: "pgvector extension not installed — vector search unavailable" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "fail", message: `pgvector check failed: ${msg}` };
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────

/** Run connectivity checks only (fast subset). */
export async function runConnectivityChecks(): Promise<DiagnosticResult> {
  const start = performance.now();

  const checks = await Promise.all([
    checkPostgresConnectivity(),
    checkTypesenseConnectivity(),
    checkOllamaConnectivity(),
  ]);

  const overallStatus = deriveOverallStatus(checks);
  const durationMs = Math.round(performance.now() - start);

  log.info(`Connectivity check: ${overallStatus} (${durationMs}ms)`);

  return { checks, overallStatus, durationMs };
}

/** Run all diagnostic checks in parallel. */
export async function runDiagnostics(): Promise<DiagnosticResult> {
  const start = performance.now();

  const checks = await Promise.all([
    // Connectivity
    checkPostgresConnectivity(),
    checkTypesenseConnectivity(),
    checkOllamaConnectivity(),
    // Config
    checkRequiredEnvVars(),
    checkProviderKeys(),
    checkAstraYml(),
    // Migrations
    checkMigrations(),
    // Agents
    checkAgents(),
    // Providers
    checkProviderInference(),
    // Memory
    checkTypesenseCollection(),
    checkEmbeddingGeneration(),
    checkPgvectorExtension(),
  ]);

  const overallStatus = deriveOverallStatus(checks);
  const durationMs = Math.round(performance.now() - start);

  log.info(`Full diagnostic: ${overallStatus} (${durationMs}ms, ${checks.length} checks)`);

  return { checks, overallStatus, durationMs };
}

/** Persist a diagnostic run to the diagnostic_runs table. */
export async function persistDiagnosticRun(result: DiagnosticResult): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO diagnostic_runs (status, results, duration_ms, run_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [result.overallStatus, JSON.stringify(result.checks), result.durationMs],
  );
  const id = rows[0].id;
  log.dim(`Persisted diagnostic run ${id}`);
  return id;
}

/** Fetch the last N diagnostic runs from the database. */
export async function getDiagnosticHistory(limit = 10): Promise<Array<{
  id: string;
  status: string;
  results: unknown;
  durationMs: number;
  runAt: string;
}>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, status, results, duration_ms AS "durationMs", run_at AS "runAt"
     FROM diagnostic_runs
     ORDER BY run_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows as Array<{
    id: string;
    status: string;
    results: unknown;
    durationMs: number;
    runAt: string;
  }>;
}
