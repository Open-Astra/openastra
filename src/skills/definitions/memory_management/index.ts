import type { SkillDefinition } from "../../types.js";

const memoryManagementSkill: SkillDefinition = {
  name: "memory_management",
  version: "1.0.0",

  manifest: {
    id: "memory_management",
    name: "Advanced Memory Management",
    description:
      "Comprehensive memory management: compression, propagation, budgets, consistency checking, feedback loops, and relation decay.",
    category: "execute",
    tools: [
      "memory_compress",
      "memory_propagate",
      "memory_budget",
      "consistency_check",
      "memory_feedback",
      "relation_decay",
    ],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "memory_management",
      instructions: `Advanced memory management tools:
- \`memory_compress\`: On-demand tier compression with before/after diff
- \`memory_propagate\`: Promote entries between tiers (daily→profile, daily→graph)
- \`memory_budget\`: Per-agent memory access limits with enforcement
- \`consistency_check\`: Cross-tier contradiction detection
- \`memory_feedback\`: Rate memory utility to fine-tune search weights
- \`relation_decay\`: Graph edge strength decay and re-verification`,
    };
  },
};

export default memoryManagementSkill;
