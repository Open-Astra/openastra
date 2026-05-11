// In-memory prompt overrides with TTL-based expiry

interface PromptOverride {
  systemPrompt: string;
  expiresAt: number; // Unix ms
}

const overrideMap = new Map<string, PromptOverride>();

export function setPromptOverride(agentId: string, systemPrompt: string, ttlSeconds = 3600): void {
  overrideMap.set(agentId, {
    systemPrompt,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export function getPromptOverride(agentId: string): string | null {
  const override = overrideMap.get(agentId);
  if (!override) return null;
  if (Date.now() > override.expiresAt) {
    overrideMap.delete(agentId);
    return null;
  }
  return override.systemPrompt;
}

export function clearPromptOverride(agentId: string): void {
  overrideMap.delete(agentId);
}
