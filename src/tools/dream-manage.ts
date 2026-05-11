import { z } from "zod";
import { registerTool } from "./registry.js";
import {
  runDreamSession,
  generateDreamExport,
  getUserDreamConfig,
  setUserDreamConfig,
  getRecentDreams,
} from "../agents/dream-mode.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { getAgentConfig } from "../config/agents.js";

// ── dream_manage ─────────────────────────────────────────────────────
// Manage dream mode: configure, trigger, view past dreams.

const DreamManageParams = z.object({
  action: z
    .enum(["config", "dream", "export", "history", "update"])
    .describe("Action: view config, start dream, export report, view history, or update config"),
  topic: z
    .string()
    .optional()
    .describe("Dream topic (optional — for 'dream' action)"),
  intensity: z
    .enum(["light", "medium", "deep"])
    .optional()
    .describe("Dream intensity (for 'dream' or 'update' action)"),
  enabled: z
    .boolean()
    .optional()
    .describe("Enable/disable dream mode (for 'update' action)"),
  scheduleHour: z
    .number()
    .optional()
    .describe("Hour to dream (0-23, for 'update' action)"),
});

registerTool({
  name: "dream_manage",
  description:
    "Manage AI dream mode — overnight offline simulation using local models. Configure dream schedules, trigger manual dreams, or view past dream reports.",
  parameters: DreamManageParams,

  async execute(params, ctx) {
    switch (params.action) {
      case "config": {
        const config = await getUserDreamConfig(ctx.uid);
        return { result: "Dream configuration", config };
      }

      case "dream": {
        const agentConfig = getAgentConfig("assistant");
        const client = getInferenceClientForAgent(agentConfig);
        const session = await runDreamSession(ctx.uid, client, {
          intensity: params.intensity,
        }, params.topic);
        return {
          result: `Dream session complete (${session.intensity})`,
          scenarios: session.scenarios.length,
          insights: session.insights.slice(0, 5),
          entities: session.entitiesDiscovered,
          durationMs: session.durationMs,
        };
      }

      case "export": {
        const agentConfig = getAgentConfig("assistant");
        const client = getInferenceClientForAgent(agentConfig);
        const report = await generateDreamExport(ctx.uid, client);
        if (!report) return { result: "No recent dream sessions to export." };
        return { result: report.title, report };
      }

      case "history": {
        const dreams = await getRecentDreams(ctx.uid, 5);
        return {
          result: `${dreams.length} recent dream(s)`,
          dreams: dreams.map((d) => ({
            id: d.id,
            intensity: d.intensity,
            topic: d.topic,
            scenarios: d.scenarios.length,
            insights: d.insights.length,
            completedAt: d.completedAt ? new Date(d.completedAt).toISOString() : undefined,
          })),
        };
      }

      case "update": {
        await setUserDreamConfig(ctx.uid, {
          enabled: params.enabled,
          intensity: params.intensity,
          scheduleHour: params.scheduleHour,
        });
        const updated = await getUserDreamConfig(ctx.uid);
        return { result: "Dream config updated", config: updated };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
