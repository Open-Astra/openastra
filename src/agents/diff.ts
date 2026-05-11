// Agent version diff utility — compares two agent version snapshots

export interface AgentDiff {
  promptDelta: string;          // "changed" | "unchanged" | first 200 chars of new
  toolsAdded: string[];
  toolsRemoved: string[];
  modelChanges: Record<string, unknown>;
}

export function diffAgentVersions(
  versionA: Record<string, unknown>,
  versionB: Record<string, unknown>,
): AgentDiff {
  const configA = (versionA.config ?? versionA) as Record<string, unknown>;
  const configB = (versionB.config ?? versionB) as Record<string, unknown>;

  // Prompt diff
  const promptA = String(configA.systemPromptTemplate ?? "");
  const promptB = String(configB.systemPromptTemplate ?? "");
  const promptDelta = promptA === promptB ? "unchanged" : `changed: ${promptB.slice(0, 200)}`;

  // Tools diff
  const toolsA = new Set<string>(((configA.tools as Record<string, unknown> | undefined)?.allow as string[]) ?? []);
  const toolsB = new Set<string>(((configB.tools as Record<string, unknown> | undefined)?.allow as string[]) ?? []);
  const toolsAdded = [...toolsB].filter((t) => !toolsA.has(t));
  const toolsRemoved = [...toolsA].filter((t) => !toolsB.has(t));

  // Model changes
  const modelA = (configA.model ?? {}) as Record<string, unknown>;
  const modelB = (configB.model ?? {}) as Record<string, unknown>;
  const modelChanges: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(modelA), ...Object.keys(modelB)])) {
    if (JSON.stringify(modelA[key]) !== JSON.stringify(modelB[key])) {
      modelChanges[key] = { from: modelA[key], to: modelB[key] };
    }
  }

  return { promptDelta, toolsAdded, toolsRemoved, modelChanges };
}
