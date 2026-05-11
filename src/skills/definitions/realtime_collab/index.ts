import type { SkillDefinition } from "../../types.js";

const realtimeCollabSkill: SkillDefinition = {
  name: "realtime_collab",
  version: "1.0.0",

  manifest: {
    id: "realtime_collab",
    name: "Real-Time Collaboration",
    description:
      "Multi-user collaborative sessions with role-based permissions. Create shared workspaces, invite participants, co-edit, and track presence in real-time.",
    category: "communicate",
    tools: ["collab_session"],
    configFields: [],
    version: "1.0.0",
  },

  init() {},

  getPromptContext() {
    return {
      skillId: "realtime_collab",
      instructions:
        "Use `collab_session` for multi-user collaboration. 'create' a session, 'invite' participants with roles (owner/editor/viewer/agent), 'message' for chat, 'edit' for collaborative editing, 'presence' for cursor tracking. Roles control permissions: owners can invite/kick, editors can read/write, viewers read-only, agents read/write.",
    };
  },
};

export default realtimeCollabSkill;
