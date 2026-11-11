import type { InferenceClient } from "./types.js";

// ── Inference Endpoint Policy ──────────────────────────────────────
// A model `endpoint` can arrive from untrusted callers (playground, agent
// CRUD, OpenAI-compat). Two things must never happen:
//   1. a platform API key is sent to an endpoint the operator didn't choose
//      (key exfiltration);
//   2. the gateway is pointed at an internal host (SSRF).
//
// Trusted endpoints are those the OPERATOR configured: astra.yml agents
// (registered by the yaml loader), provider base-URL env vars, and the
// INFERENCE_ENDPOINT_ALLOWLIST env var (comma-separated URLs/origins).
// Everything else is untrusted: rejected outright for keyed providers and
// SSRF-checked before every use for keyless ones.

const registeredOrigins = new Set<string>();

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Mark an operator-configured endpoint (e.g. from astra.yml) as trusted. */
export function trustInferenceEndpoint(url: string | undefined | null): void {
  if (!url) return;
  const origin = originOf(url);
  if (origin) registeredOrigins.add(origin);
}

function envOrigins(): Set<string> {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    if (!v) return;
    for (const part of v.split(",")) {
      const origin = originOf(part.trim());
      if (origin) out.add(origin);
    }
  };
  add(process.env.INFERENCE_ENDPOINT_ALLOWLIST);
  add(process.env.OLLAMA_BASE_URL);
  add(process.env.EDGE_INFERENCE_URL);
  add(process.env.VLLM_BASE_URL);
  add(process.env.LMSTUDIO_BASE_URL);
  return out;
}

export function isTrustedInferenceEndpoint(url: string): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return registeredOrigins.has(origin) || envOrigins().has(origin);
}

export class UntrustedEndpointError extends Error {
  constructor(provider: string, endpoint: string) {
    super(
      `Endpoint "${endpoint}" is not allowed for provider "${provider}". ` +
      `Custom endpoints must be configured by the operator (astra.yml or INFERENCE_ENDPOINT_ALLOWLIST).`,
    );
    this.name = "UntrustedEndpointError";
  }
}

/**
 * For providers that attach a platform API key: a non-default endpoint is
 * only accepted when the operator has trusted it.
 */
export function assertKeyedEndpointAllowed(
  provider: string,
  endpoint: string | undefined,
  defaultEndpoint: string,
): void {
  if (!endpoint) return;
  if (originOf(endpoint) === originOf(defaultEndpoint)) return;
  if (isTrustedInferenceEndpoint(endpoint)) return;
  throw new UntrustedEndpointError(provider, endpoint);
}

/** Syntactic validation shared by every endpoint. */
export function assertValidEndpointUrl(provider: string, endpoint: string): void {
  if (!originOf(endpoint)) throw new UntrustedEndpointError(provider, endpoint);
}

const SSRF_RECHECK_MS = 30_000;

/**
 * Wrap a client that talks to an UNTRUSTED endpoint so that every call first
 * verifies the URL does not resolve to an internal/metadata address.
 * Fails closed if the guard itself errors.
 */
export function guardUntrustedEndpoint(
  client: InferenceClient,
  provider: string,
  endpoint: string,
): InferenceClient {
  let lastOkAt = 0;

  async function check(): Promise<void> {
    if (Date.now() - lastOkAt < SSRF_RECHECK_MS) return;
    let blocked: boolean;
    try {
      const { isBlockedUrl } = await import("../utils/ssrf-guard.js");
      blocked = await isBlockedUrl(endpoint);
    } catch {
      blocked = true;
    }
    if (blocked) throw new UntrustedEndpointError(provider, endpoint);
    lastOkAt = Date.now();
  }

  return {
    async chat(request) {
      await check();
      return client.chat(request);
    },
    async *chatStream(request) {
      await check();
      yield* client.chatStream(request);
    },
  };
}

/** Circuit-breaker key: provider plus endpoint host for trusted custom endpoints. */
export function breakerLabel(provider: string, endpoint: string | undefined): string {
  if (!endpoint) return provider;
  const origin = originOf(endpoint);
  if (!origin) return provider;
  // Untrusted endpoints share one bucket per provider so user-supplied URLs
  // cannot grow the registry without bound or trip the operator's breaker.
  return isTrustedInferenceEndpoint(endpoint)
    ? `${provider}@${new URL(origin).host}`
    : `${provider}@untrusted`;
}

/** Test helper. */
export function _resetTrustedEndpoints(): void {
  registeredOrigins.clear();
}
