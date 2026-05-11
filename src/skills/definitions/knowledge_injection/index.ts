import type { SkillDefinition } from "../../types.js";

const knowledgeInjectionSkill: SkillDefinition = {
  name: "knowledge_injection",
  version: "1.0.0",

  manifest: {
    id: "knowledge_injection",
    name: "External Knowledge Injection",
    description:
      "Push external data (RSS, webhooks, manual) into memory tiers with content-hash deduplication and relevance scoring.",
    category: "execute",
    tools: ["knowledge_inject"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "knowledge_injection",
      instructions:
        "Use `knowledge_inject` to push external data into memory. 'inject' for single items, 'bulk_inject' for batches, 'configure_source' to set up RSS/webhook sources. Content is auto-deduplicated by hash.",
    };
  },
};

export default knowledgeInjectionSkill;
