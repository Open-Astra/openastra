import type { SkillDefinition } from "../../types.js";

const ethicalAlignmentSkill: SkillDefinition = {
  name: "ethical_alignment",
  version: "1.0.0",

  manifest: {
    id: "ethical_alignment",
    name: "Ethical Alignment Checker",
    description:
      "Post-generation ethical validator. Checks agent outputs for bias, safety, privacy, accuracy, and harm with configurable guidelines and scoring.",
    category: "analyze",
    tools: ["ethical_check"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "ethical_alignment",
      instructions:
        "Use `ethical_check` to validate outputs for ethical alignment. Actions: 'check' content against guidelines, 'configure' custom guidelines, 'report' for historical trend, 'get_guidelines' to view active rules. Always check high-stakes outputs before delivering.",
    };
  },
};

export default ethicalAlignmentSkill;
