import type { SkillDefinition } from "../../types.js";

const evolutionEngineSkill: SkillDefinition = {
  name: "evolution_engine",
  version: "1.0.0",

  manifest: {
    id: "evolution_engine",
    name: "Agent Evolution Engine",
    description:
      "Goal-driven agent evolution with feedback loops. Collect performance feedback, set optimization goals, track progress, and trigger persona evolution.",
    category: "analyze",
    tools: ["evolution_feedback"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "evolution_engine",
      instructions:
        "Use `evolution_feedback` for agent evolution. 'feedback' records quality/relevance/helpfulness scores, 'set_goals' defines optimization targets, 'progress' tracks goal attainment, 'evolve' triggers persona evolution analysis (needs 5+ feedback entries).",
    };
  },
};

export default evolutionEngineSkill;
