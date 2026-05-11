import type { SkillDefinition } from "../../types.js";

const codeReviewSwarmSkill: SkillDefinition = {
  name: "code_review_swarm",
  version: "1.0.0",

  manifest: {
    id: "code_review_swarm",
    name: "Code Review Swarm",
    description:
      "Autonomous multi-agent code review. Spawns specialized agents (security, performance, style, architecture) that independently review code and produce a merged report.",
    category: "analyze",
    tools: ["code_review_swarm", "swarm_observe"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "code_review_swarm",
      instructions:
        "Use `code_review_swarm` to launch multi-perspective code reviews. Specify reviewers (security, performance, style, architecture, test_coverage) and severity threshold. Use `swarm_observe` to monitor the review swarm's progress.",
    };
  },
};

export default codeReviewSwarmSkill;
