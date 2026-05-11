// ── Team Knowledge Skill ────────────────────────────────────────────
// Wraps the four workspace collaboration tools (memory write/search,
// knowledge write/search) into a single skill that agents can opt into.
// Tools are already registered via tools/index.ts — this skill just
// declares the manifest and provides prompt context.

import type { SkillDefinition } from "../../types.js";

const teamKnowledgeSkill: SkillDefinition = {
  name: "team_knowledge",
  version: "1.0.0",

  manifest: {
    id: "team_knowledge",
    name: "Team Knowledge",
    description:
      "Workspace-scoped memory and knowledge base for team collaboration. Write and search shared decisions, ADRs, standups, retrospectives, standards, runbooks, FAQs, and glossary entries.",
    category: "analyze",
    tools: [
      "workspace_memory_write",
      "workspace_memory_search",
      "workspace_knowledge_write",
      "workspace_knowledge_search",
    ],
    configFields: [],
    version: "1.0.0",
  },

  init() {
    // Tools are already registered via tools/index.ts at import time.
    // No additional initialization needed.
  },

  getPromptContext() {
    return {
      skillId: "team_knowledge",
      instructions: [
        "You have access to team-scoped workspace memory and knowledge tools.",
        "",
        "**Workspace Memory** (`workspace_memory_write`, `workspace_memory_search`):",
        "- Write team decisions, standup notes, retrospectives, and shared context",
        "- Categories: decision, adr, standup, retrospective, note, knowledge",
        "- Search uses semantic similarity for accurate retrieval",
        "",
        "**Workspace Knowledge** (`workspace_knowledge_write`, `workspace_knowledge_search`):",
        "- Create structured knowledge entries: ADRs, standards, runbooks, FAQs, glossary",
        "- Entries have a lifecycle: active → deprecated → superseded",
        "- Search across all knowledge types with optional filters",
        "",
        "Use these tools to build and query your team's shared knowledge base.",
        "Always check existing knowledge before creating duplicate entries.",
      ].join("\n"),
    };
  },
};

export default teamKnowledgeSkill;
