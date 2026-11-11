import { isBlockedUrl } from "../../utils/ssrf-guard.js";

// ── Model Endpoint Guard ────────────────────────────────────────────
// A caller-supplied model endpoint is dangerous in two ways:
//   • keyed providers (grok, openai, …): the gateway attaches the
//     platform's API key to whatever URL is given → key exfiltration.
//   • keyless/self-hosted providers (ollama, vllm, …): the gateway makes
//     a request to an arbitrary URL and returns the body → SSRF.
//
// Policy:
//   • Keyed providers never accept a custom endpoint from the API.
//     (Operators configure endpoints in astra.yml / env.)
//   • Self-hosted providers accept one only from a platform admin, and
//     the URL must pass the SSRF guard unless the operator has opted in
//     to private addresses with ALLOW_PRIVATE_MODEL_ENDPOINTS=true.

const SELF_HOSTED_PROVIDERS = new Set(["ollama", "vllm", "edge", "lmstudio", "local"]);

export interface ModelEndpointInput {
  provider: string;
  endpoint?: string | null;
}

/**
 * Returns null when the endpoint is acceptable, or a human-readable
 * rejection reason otherwise.
 */
export async function checkModelEndpoint(
  model: ModelEndpointInput | undefined,
  opts: { isAdmin: boolean },
): Promise<string | null> {
  if (!model?.endpoint) return null;

  if (!SELF_HOSTED_PROVIDERS.has(model.provider)) {
    return `Custom endpoints are not accepted for provider "${model.provider}"`;
  }

  if (!opts.isAdmin) {
    return "Setting a model endpoint requires the platform admin key (X-Api-Key)";
  }

  let parsed: URL;
  try {
    parsed = new URL(model.endpoint);
  } catch {
    return "Model endpoint is not a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Model endpoint must be http(s)";
  }

  if (process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS === "true") return null;

  let blocked = true;
  try {
    blocked = await isBlockedUrl(model.endpoint);
  } catch {
    blocked = true; // fail closed
  }
  if (blocked) {
    return "Model endpoint resolves to a private or blocked address " +
      "(set ALLOW_PRIVATE_MODEL_ENDPOINTS=true to permit operator-supplied private endpoints)";
  }
  return null;
}
