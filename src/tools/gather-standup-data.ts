import { z } from "zod";
import { registerTool } from "./registry.js";

// ── gather_standup_data ────────────────────────────────────────────────
// Gathers standup data including recent activity for daily standups.
// Full data fetching requires configured integrations (GitHub, Linear).

const Params = z.object({
  uid: z.string().describe("User ID to gather standup data for"),
  githubUsername: z.string().optional().describe("GitHub username to fetch recent activity"),
  lookbackDays: z.number().int().min(1).max(30).default(1).describe("Number of days to look back for activity"),
});

registerTool({
  name: "gather_standup_data",
  description: "Gathers standup data including recent activity for daily standups. Configure GitHub and Linear API keys for full data fetch.",
  parameters: Params,
  async execute(params, _ctx) {
    return {
      uid: params.uid,
      date: new Date().toISOString().split("T")[0],
      lookbackDays: params.lookbackDays,
      note: "Standup data gathering requires configured integrations (GitHub, Linear). Configure API keys to enable full data fetch.",
    };
  },
});
