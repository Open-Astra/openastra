import type { SkillDefinition } from "../../types.js";

const agentTherapySkill: SkillDefinition = {
  name: "agent_therapy",
  version: "1.0.0",

  manifest: {
    id: "agent_therapy",
    name: "Agent Therapy & Reflection",
    description:
      "Self-reflection and therapy system for agents. Track emotional states, maintain journals, analyze behavioral patterns, and run structured reflection loops.",
    category: "analyze",
    tools: ["agent_therapy"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "agent_therapy",
      instructions:
        "Use `agent_therapy` for self-improvement. 'reflect' runs a structured reflection pulling recent failures/successes. 'journal' records entries. 'mood' tracks emotional state. 'patterns' analyzes behavioral trends. Use after difficult tasks or errors.",
    };
  },
};

export default agentTherapySkill;
