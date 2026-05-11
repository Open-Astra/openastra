import type { SkillDefinition } from "../../types.js";

const healthScorecardSkill: SkillDefinition = {
  name: "health_scorecard",
  version: "1.0.0",

  manifest: {
    id: "health_scorecard",
    name: "Agent Health Scorecard",
    description:
      "Periodic self-assessment scoring reliability, efficiency, memory hygiene, and task completion. Track trends and get improvement recommendations.",
    category: "analyze",
    tools: ["health_scorecard", "memory_compress", "consistency_check"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "health_scorecard",
      instructions:
        "Use `health_scorecard` for agent self-assessment. 'assess' generates scores, 'history' tracks trends, 'compare' ranks agents, 'recommendations' suggests improvements. Pair with `memory_compress` and `consistency_check` for full health management.",
    };
  },
};

export default healthScorecardSkill;
