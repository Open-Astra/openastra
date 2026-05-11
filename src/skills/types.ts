import type { GatewayPlugin, PluginContext } from "../plugins/types.js";

// ── Skill Definition ────────────────────────────────────────────────
// A skill extends GatewayPlugin with additional metadata for the
// skill registry. Skills register tools and inject prompt context
// into agents that list them.

export interface SkillConfigField {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  envVar?: string; // optional env var that provides the value
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  category: "search" | "transform" | "execute" | "communicate" | "analyze";
  tools: string[]; // tool names this skill registers
  configFields: SkillConfigField[];
  version: string;
  requires?: string[]; // optional skill or tool IDs this skill depends on
  composes?: string[]; // skill IDs whose tools + context this skill includes
}

export interface SkillPromptContext {
  skillId: string;
  instructions: string; // injected into the agent's system prompt
}

export interface SkillDefinition extends GatewayPlugin {
  manifest: SkillManifest;
  getPromptContext?(): SkillPromptContext;
  getContextData?(uid: string, query: string): Promise<string | null>;
}

// ── Skill Context ──────────────────────────────────────────────────
// Same as PluginContext — skills use the same init mechanism.

export type SkillContext = PluginContext;
