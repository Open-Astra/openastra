import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Send Webhook Skill ────────────────────────────────────────────
// Sends a POST request to a webhook URL with a JSON payload.

const SendWebhookParams = z.object({
  url: z.string().url().describe("Webhook URL to send the POST request to"),
  payload: z.record(z.string(), z.unknown()).describe("JSON payload to send in the request body"),
  headers: z.record(z.string(), z.string()).optional().describe("Optional additional HTTP headers"),
});

const sendWebhookSkill: SkillDefinition = {
  name: "send_webhook",
  version: "1.0.0",

  manifest: {
    id: "send_webhook",
    name: "Send Webhook",
    description: "Sends a POST request with a JSON payload to a webhook URL.",
    category: "communicate",
    tools: ["send_webhook"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "send_webhook",
      description: "Send a POST request with a JSON payload to a webhook URL. Useful for triggering external services, Slack notifications, Zapier workflows, etc.",
      parameters: SendWebhookParams,

      async execute(params) {
        const requestHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "Astra-Agent/1.0",
          ...params.headers,
        };

        try {
          const response = await safeFetch(params.url, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(params.payload),
            timeoutMs: 15_000,
          });

          const responseText = await response.text();
          let responseBody: unknown;
          try {
            responseBody = JSON.parse(responseText);
          } catch {
            responseBody = responseText;
          }

          return {
            success: response.ok,
            statusCode: response.status,
            statusText: response.statusText,
            response: responseBody,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Webhook request failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "send_webhook",
      instructions: "You can send webhook POST requests using the `send_webhook` tool. Provide a URL and JSON payload.",
    };
  },
};

export default sendWebhookSkill;
