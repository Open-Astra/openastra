export type SuggestionType = "add_tool" | "remove_tool" | "add_skill" | "remove_skill" | "prompt_update" | "temperature_change";

export interface SpecializationSnapshot {
  id: string; workspaceId: string; agentId: string; snapshotAt: string;
  toolUsage: Record<string, unknown>; skillUsage: Record<string, unknown>;
  taskCategories: Record<string, unknown>; successByCategory: Record<string, unknown>;
  recommendedTools: string[]; recommendedSkills: string[];
  recommendedPromptAdditions: string | null; specializationScore: number;
}

export interface EvolutionSuggestion {
  id: string; workspaceId: string; agentId: string;
  suggestionType: SuggestionType; suggestionDetail: string;
  confidence: number; rationale: string;
  applied: boolean; appliedAt: string | null; createdAt: string;
}

export function rowToSnapshot(r: Record<string, unknown>): SpecializationSnapshot {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string, snapshotAt: r.snapshot_at as string,
    toolUsage: (r.tool_usage ?? {}) as Record<string, unknown>,
    skillUsage: (r.skill_usage ?? {}) as Record<string, unknown>,
    taskCategories: (r.task_categories ?? {}) as Record<string, unknown>,
    successByCategory: (r.success_by_category ?? {}) as Record<string, unknown>,
    recommendedTools: (r.recommended_tools ?? []) as string[],
    recommendedSkills: (r.recommended_skills ?? []) as string[],
    recommendedPromptAdditions: (r.recommended_prompt_additions as string) ?? null,
    specializationScore: parseFloat(r.specialization_score as string),
  };
}

export function rowToSuggestion(r: Record<string, unknown>): EvolutionSuggestion {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    suggestionType: r.suggestion_type as SuggestionType,
    suggestionDetail: r.suggestion_detail as string,
    confidence: parseFloat(r.confidence as string),
    rationale: r.rationale as string, applied: r.applied as boolean,
    appliedAt: (r.applied_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}
