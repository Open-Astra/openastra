import type { SkillDefinition } from "../../types.js";

const scenarioEngineSkill: SkillDefinition = {
  name: "scenario_engine",
  version: "1.0.0",

  manifest: {
    id: "scenario_engine",
    name: "What-If Scenario Engine",
    description:
      "Run parallel what-if simulations by forking memory branches, analyzing scenarios independently, and comparing outcomes side-by-side.",
    category: "analyze",
    tools: ["scenario_engine"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "scenario_engine",
      instructions:
        "Use `scenario_engine` to explore what-if questions. Use 'compare' with 2+ scenarios for side-by-side analysis, 'run_single' for a quick exploration, or 'list'/'cleanup' to manage scenario branches.",
    };
  },
};

export default scenarioEngineSkill;
