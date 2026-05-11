import { z } from "zod";
import { registerTool } from "./registry.js";

// ── email_send ────────────────────────────────────────────────────────
// Send emails via the Resend API.

const EmailSendParams = z.object({
  to: z
    .string()
    .email()
    .describe("Recipient email address"),
  subject: z
    .string()
    .min(1)
    .max(998)
    .describe("Email subject line"),
  body: z
    .string()
    .min(1)
    .describe("Email body content (plain text or HTML)"),
  html: z
    .boolean()
    .default(false)
    .describe("Whether the body is HTML (default false — plain text)"),
});

registerTool({
  name: "email_send",
  description:
    "Send an email via the Resend API. Supports plain text and HTML emails. Requires RESEND_API_KEY to be configured. Use for sending notifications, reports, summaries, or any email communication.",
  parameters: EmailSendParams,
  async execute(params) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { error: "RESEND_API_KEY is required to send emails. Configure it in your environment." };
    }

    try {
      const payload: Record<string, unknown> = {
        from: process.env.RESEND_FROM_EMAIL || "Astra <noreply@astra.agent>",
        to: [params.to],
        subject: params.subject,
      };

      if (params.html) {
        payload.html = params.body;
      } else {
        payload.text = params.body;
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        return { error: `Resend API error (${res.status}): ${body}` };
      }

      const data = (await res.json()) as { id?: string };

      return {
        id: data.id ?? "unknown",
        status: "sent",
        to: params.to,
        subject: params.subject,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
