import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPrimaryInferenceClient } from "./factory-internal.js";
import { createLogger } from "../utils/logger.js";

// ── Provider Cache Warmer ──────────────────────────────────────────────
// Sends a minimal dummy request to each configured provider on startup
// to prime their server-side prefix cache for SOUL.md + tool schemas.
// Called once after skills/plugins are loaded, before HTTP server opens.
//
// Enable via: CACHE_WARMUP_ENABLED=true

const log = createLogger("cache-warmer");

export interface WarmableProvider {
  provider: string;
  modelId: string;
  apiKey?: string;
}

/**
 * Returns the list of providers to warm based on which API keys are present
 * in the supplied env record.
 */
export function getWarmableProviders(
  env: Record<string, string | undefined>,
): WarmableProvider[] {
  const providers: WarmableProvider[] = [];

  if (env.ANTHROPIC_API_KEY) {
    providers.push({ provider: "claude", modelId: "claude-haiku-4-5-20251001" });
  }
  if (env.OPENAI_API_KEY) {
    providers.push({ provider: "openai", modelId: "gpt-4o-mini" });
  }
  if (env.GEMINI_API_KEY) {
    providers.push({ provider: "gemini", modelId: "gemini-flash" });
  }

  return providers;
}

/**
 * Sends a minimal warm-up request to each provider to prime their
 * server-side prefix caches (SOUL.md system prompt prefix).
 *
 * - Skips entirely when CACHE_WARMUP_ENABLED !== "true"
 * - Never throws — all errors are logged as dim messages so startup is unaffected
 */
export async function warmProviderCaches(
  providers: WarmableProvider[],
): Promise<void> {
  if (process.env.CACHE_WARMUP_ENABLED !== "true") {
    log.dim("Cache warm-up disabled (set CACHE_WARMUP_ENABLED=true to enable)");
    return;
  }

  if (providers.length === 0) {
    log.dim("No providers to warm — no recognised API keys found");
    return;
  }

  // Read SOUL.md once — shared across all provider warm-up calls
  let soulContent = "";
  try {
    const soulPath = join(process.cwd(), "SOUL.md");
    soulContent = await readFile(soulPath, "utf-8");
  } catch {
    log.dim("SOUL.md not found — warming with empty system prompt");
  }

  const warmPromises = providers.map(async (p) => {
    try {
      const client = createPrimaryInferenceClient(p.provider, p.modelId);

      await client.chat({
        messages: [
          ...(soulContent
            ? [{ role: "system" as const, content: soulContent }]
            : []),
          { role: "user" as const, content: "warm" },
        ],
        maxTokens: 1,
        temperature: 0,
      });

      log.dim(`Warmed provider cache: ${p.provider}/${p.modelId}`);
    } catch (err) {
      log.dim(
        `Cache warm-up failed for ${p.provider}/${p.modelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  await Promise.allSettled(warmPromises);
}
