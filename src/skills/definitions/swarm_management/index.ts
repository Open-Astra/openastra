import type { SkillDefinition } from "../../types.js";

const swarmManagementSkill: SkillDefinition = {
  name: "swarm_management",
  version: "1.0.0",

  manifest: {
    id: "swarm_management",
    name: "Swarm Management & Orchestration",
    description:
      "Advanced swarm management: meta-controller for multi-swarm oversight, observer agents, blackboard topics, and debate evidence witnesses.",
    category: "execute",
    tools: [
      "meta_controller",
      "swarm_observe",
      "blackboard_topic",
      "debate_witness",
    ],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "swarm_management",
      instructions: `Swarm management tools:
- \`meta_controller\`: Multi-swarm oversight with resource allocation and load balancing
- \`swarm_observe\`: Read-only monitoring of swarm status, alerts, and timelines
- \`blackboard_topic\`: Named topic/channel pub/sub for selective swarm communication
- \`debate_witness\`: Evidence retrieval from memory for debate conflict resolution`,
    };
  },
};

export default swarmManagementSkill;
