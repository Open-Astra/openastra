import type { SkillDefinition } from "../../types.js";

const graphEvolutionSkill: SkillDefinition = {
  name: "graph_evolution",
  version: "1.0.0",

  manifest: {
    id: "graph_evolution",
    name: "Knowledge Graph Schema Evolution",
    description:
      "Meta-agent that observes knowledge graph patterns, proposes new entity/edge types, and manages schema additions with approval workflow.",
    category: "analyze",
    tools: ["graph_schema_evolve"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "graph_evolution",
      instructions:
        "Use `graph_schema_evolve` to evolve the knowledge graph schema. 'analyze' discovers patterns, 'propose' suggests new types, 'approve'/'reject' manages proposals, 'current_schema' shows existing types.",
    };
  },
};

export default graphEvolutionSkill;
