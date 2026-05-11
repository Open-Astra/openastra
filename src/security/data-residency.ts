import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("data-residency");

// Provider → region mapping (approximate)
const PROVIDER_REGIONS: Record<string, string[]> = {
  openai: ["us", "us-east"],
  claude: ["us", "us-east"],
  gemini: ["us", "us-central"],
  groq: ["us"],
  grok: ["us"],
  ollama: ["local"],
  vllm: ["local"],
  openrouter: ["us"],
  mistral: ["eu", "eu-west"],
  bedrock: ["us", "eu", "ap"],
};

export async function checkDataResidency(
  provider: string,
  workspaceId: string,
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ allowed_regions: string[]; allowed_providers: string[] }>(
    `SELECT allowed_regions, allowed_providers FROM workspace_data_policies WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (result.rows.length === 0) return true; // no policy = allow all

  const policy = result.rows[0]!;

  // Check if provider is in allowed providers list
  if (policy.allowed_providers.length > 0 && !policy.allowed_providers.includes(provider)) {
    log.warn(`Data residency: provider ${provider} not in allowed list for workspace ${workspaceId}`);
    return false;
  }

  // Check region alignment if regions are specified
  if (policy.allowed_regions.length > 0) {
    const providerRegions = PROVIDER_REGIONS[provider] ?? ["unknown"];
    const allowed = policy.allowed_regions.some((region) =>
      providerRegions.some((pr) => pr.startsWith(region) || region.startsWith(pr)),
    );
    if (!allowed) {
      log.warn(`Data residency: provider ${provider} (regions: ${providerRegions.join(",")}) violates workspace policy`);
      return false;
    }
  }

  return true;
}
