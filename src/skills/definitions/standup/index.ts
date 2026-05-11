import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Standup Skill ─────────────────────────────────────────────────────
// Facilitates daily standups by gathering activity data and helping
// format responses for yesterday/today/blockers format.

const GatherStandupDataParams = z.object({
  uid: z.string().describe("User ID to gather standup data for"),
  githubUsername: z.string().optional().describe("GitHub username to fetch recent activity"),
  lookbackDays: z.number().int().min(1).max(30).default(1).describe("Number of days to look back for activity"),
});

const standupSkill: SkillDefinition = {
  name: "standup",
  version: "1.0.0",

  manifest: {
    id: "standup",
    name: "Daily Standup",
    description: "Facilitates daily standups by gathering recent activity and prompting structured yesterday/today/blockers responses.",
    category: "communicate",
    tools: ["gather_standup_data"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "gather_standup_data",
      description: "Gathers standup data including recent activity for daily standups. Configure GitHub and Linear API keys for full data fetch.",
      parameters: GatherStandupDataParams,

      async execute(params, _toolCtx) {
        return {
          uid: params.uid,
          date: new Date().toISOString().split("T")[0],
          lookbackDays: params.lookbackDays,
          note: "Standup data gathering requires configured integrations (GitHub, Linear). Configure API keys to enable full data fetch.",
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "standup",
      instructions: [
        "You facilitate daily standups using the `gather_standup_data` tool.",
        "Ask each participant for:",
        "1. What did you complete yesterday?",
        "2. What are you working on today?",
        "3. Any blockers or impediments?",
        "Gather data with `gather_standup_data` before summarizing team progress.",
        "Keep standup responses concise and action-oriented.",
      ].join("\n"),
    };
  },
};

export default standupSkill;
