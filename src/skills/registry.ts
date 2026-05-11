import type { SkillDefinition, SkillManifest, SkillPromptContext } from "./types.js";

// ── Skill Registry ──────────────────────────────────────────────────
// Central registry for all loaded skills. Skills register themselves
// during the init phase, similar to how plugins work.

const skills = new Map<string, SkillDefinition>();

export function registerSkill(skill: SkillDefinition): void {
  if (skills.has(skill.manifest.id)) {
    console.warn(`[skills] Overwriting existing skill: ${skill.manifest.id}`);
  }
  skills.set(skill.manifest.id, skill);
  if (!process.env.ASTRA_STANDALONE) {
    console.log(`[skills] Registered: ${skill.manifest.id} (${skill.manifest.tools.join(", ")})`);
  }
}

export function getSkill(id: string): SkillDefinition | undefined {
  return skills.get(id);
}

export function getAllSkills(): Map<string, SkillDefinition> {
  return skills;
}

// ── Skill Tool Resolution ───────────────────────────────────────────
// Given a list of skill IDs on an agent config, resolve all tool names
// those skills provide. Used by the agent loop to expand the allow set.

export function getSkillToolNames(skillIds: string[], _visited: Set<string> = new Set()): string[] {
  const toolNames: string[] = [];
  for (const id of skillIds) {
    if (_visited.has(id)) continue; // prevent cycles
    _visited.add(id);
    const skill = skills.get(id);
    if (!skill) continue;
    toolNames.push(...skill.manifest.tools);
    // Recursively include tools from composed skills
    if (skill.manifest.composes?.length) {
      toolNames.push(...getSkillToolNames(skill.manifest.composes, _visited));
    }
  }
  return [...new Set(toolNames)]; // deduplicate
}

// ── Skill Prompt Context ────────────────────────────────────────────
// Gather prompt injection text from all skills an agent has.

export function getSkillPromptContext(skillIds: string[], _visited: Set<string> = new Set()): string {
  const contexts: SkillPromptContext[] = [];

  for (const id of skillIds) {
    if (_visited.has(id)) continue;
    _visited.add(id);
    const skill = skills.get(id);
    if (!skill) continue;
    if (skill?.getPromptContext) {
      contexts.push(skill.getPromptContext());
    }
    // Recursively include prompt context from composed skills
    if (skill.manifest.composes?.length) {
      // Get composed contexts — only their text, not the headers
      for (const compId of skill.manifest.composes) {
        if (_visited.has(compId)) continue;
        const compSkill = skills.get(compId);
        if (compSkill?.getPromptContext) {
          contexts.push(compSkill.getPromptContext());
          _visited.add(compId);
        }
      }
    }
  }

  if (contexts.length === 0) return "";

  // Frame skill context as primary instructions, not reference docs.
  // "Available Skills" framing made the model treat detailed editorial
  // guidelines as documentation rather than directives it must follow.
  const lines: string[] = [];
  for (const ctx of contexts) {
    lines.push(ctx.instructions);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Skill Manifests ─────────────────────────────────────────────────
// Return all manifests for the skill catalog API.

export function getSkillManifests(): SkillManifest[] {
  return [...skills.values()].map((s) => s.manifest);
}

// ── Skill-to-Tool Reverse Lookup ────────────────────────────────────
// Given a tool name, return the ID of the skill that owns it.

export function getSkillForTool(toolName: string): string | null {
  for (const [id, skill] of skills) {
    if (skill.manifest.tools.includes(toolName)) {
      return id;
    }
  }
  return null;
}

// ── Skill Context Data ───────────────────────────────────────────────
// Calls each skill's getContextData hook in parallel and joins results.

export async function getSkillContextData(
  skillIds: string[],
  uid: string,
  query: string,
): Promise<string> {
  const results = await Promise.all(
    skillIds.map(async (id) => {
      const skill = skills.get(id);
      if (!skill?.getContextData) return null;
      return skill.getContextData(uid, query).catch(() => null);
    }),
  );
  return results.filter(Boolean).join("\n\n");
}
