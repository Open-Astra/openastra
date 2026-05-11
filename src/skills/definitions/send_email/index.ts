import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Send Email Skill ──────────────────────────────────────────────
// Sends emails via the Resend API.
// Requires RESEND_API_KEY environment variable.

const RESEND_API_URL = "https://api.resend.com/emails";

const SendEmailParams = z.object({
  to: z.string().describe("Recipient email address"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content (plain text)"),
});

const sendEmailSkill: SkillDefinition = {
  name: "send_email",
  version: "1.0.0",

  manifest: {
    id: "send_email",
    name: "Send Email",
    description: "Send emails via the Resend API. Supports plain text email delivery.",
    category: "communicate",
    tools: ["send_email"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: true,
        description: "Resend API key for sending emails",
        envVar: "RESEND_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "send_email",
      description: "Send an email to a recipient via the Resend API. Requires RESEND_API_KEY to be configured.",
      parameters: SendEmailParams,

      async execute(params) {
        const apiKey = process.env.RESEND_API_KEY;
        if (!apiKey) {
          return { error: "RESEND_API_KEY environment variable is not set." };
        }

        const payload = {
          from: "Astra <noreply@astra.ai>",
          to: params.to,
          subject: params.subject,
          text: params.body,
        };

        try {
          const response = await safeFetch(RESEND_API_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            ssrfProtection: false,
          });

          if (!response.ok) {
            const errorText = await response.text();
            return { error: `Resend API returned ${response.status}: ${errorText}` };
          }

          const result = (await response.json()) as { id: string };

          return {
            success: true,
            messageId: result.id,
            to: params.to,
            subject: params.subject,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Failed to send email: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "send_email",
      instructions: "You can send emails using the `send_email` tool. Provide recipient, subject, and body text.",
    };
  },
};

export default sendEmailSkill;
