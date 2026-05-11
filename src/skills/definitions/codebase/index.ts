import type { SkillDefinition } from "../../types.js";

// ── Codebase Intelligence Skill ────────────────────────────────────
// Wraps codebase_index and codebase_search tools for repository
// indexing, symbol extraction, and semantic code search.

const codebaseSkill: SkillDefinition = {
  name: "codebase",
  version: "1.0.0",

  manifest: {
    id: "codebase",
    name: "Codebase Intelligence",
    description:
      "Index and search codebases with symbol extraction and semantic search.",
    category: "analyze",
    tools: ["codebase_index", "codebase_search"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "codebase",
      instructions:
        "You can index codebases with `codebase_index` and search them with `codebase_search`. Index first, then search semantically or by symbol name.",
    };
  },
};

export default codebaseSkill;
