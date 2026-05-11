import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── SMS Messaging Skill ─────────────────────────────────────────────
// Send and receive SMS via Twilio API.
// Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.

const SendSmsParams = z.object({
  to: z.string().describe("Recipient phone number in E.164 format (e.g. +15551234567)"),
  body: z.string().max(1600).describe("Message body (max 1600 chars)"),
});

const ListSmsParams = z.object({
  limit: z.number().int().min(1).max(50).default(10).describe("Number of recent messages to fetch"),
  direction: z.enum(["inbound", "outbound", "all"]).default("all").describe("Filter by direction"),
});

const smsMessagingSkill: SkillDefinition = {
  name: "sms_messaging",
  version: "1.0.0",

  manifest: {
    id: "sms_messaging",
    name: "SMS Messaging",
    description: "Send and receive SMS messages via Twilio. Supports E.164 phone numbers and message history.",
    category: "communicate",
    tools: ["sms_send", "sms_list"],
    configFields: [
      { name: "accountSid", type: "string", required: true, description: "Twilio Account SID", envVar: "TWILIO_ACCOUNT_SID" },
      { name: "authToken", type: "string", required: true, description: "Twilio Auth Token", envVar: "TWILIO_AUTH_TOKEN" },
      { name: "phoneNumber", type: "string", required: true, description: "Twilio phone number", envVar: "TWILIO_PHONE_NUMBER" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      sid: process.env.TWILIO_ACCOUNT_SID ?? "",
      token: process.env.TWILIO_AUTH_TOKEN ?? "",
      from: process.env.TWILIO_PHONE_NUMBER ?? "",
    });

    ctx.registerTool({
      name: "sms_send",
      description: "Send an SMS message to a phone number via Twilio.",
      parameters: SendSmsParams,

      async execute(params) {
        const { sid, token, from } = getConfig();
        if (!sid || !token || !from) return { error: "Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)." };

        const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
        const body = new URLSearchParams({ To: params.to, From: from, Body: params.body }).toString();

        const res = await safeFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          },
          body,
          ssrfProtection: false,
        });

        if (!res.ok) {
          const err = await res.text();
          return { error: `Twilio API error ${res.status}: ${err.slice(0, 200)}` };
        }

        const data = (await res.json()) as { sid: string; status: string; date_created: string };
        return { success: true, messageSid: data.sid, status: data.status, to: params.to };
      },
    });

    ctx.registerTool({
      name: "sms_list",
      description: "List recent SMS messages from Twilio history.",
      parameters: ListSmsParams,

      async execute(params) {
        const { sid, token } = getConfig();
        if (!sid || !token) return { error: "Twilio credentials not configured." };

        const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
        url.searchParams.set("PageSize", String(params.limit));

        const res = await safeFetch(url.toString(), {
          headers: { "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
          ssrfProtection: false,
        });

        if (!res.ok) return { error: `Twilio API error ${res.status}` };

        const data = (await res.json()) as { messages: Array<{ sid: string; from: string; to: string; body: string; direction: string; date_sent: string; status: string }> };
        let messages = data.messages ?? [];

        if (params.direction !== "all") {
          messages = messages.filter((m) => m.direction.includes(params.direction));
        }

        return {
          count: messages.length,
          messages: messages.map((m) => ({
            sid: m.sid,
            from: m.from,
            to: m.to,
            body: m.body?.slice(0, 500),
            direction: m.direction,
            date: m.date_sent,
            status: m.status,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "sms_messaging",
      instructions: "You can send SMS via `sms_send` (provide phone number in E.164 format and message body) and list recent messages with `sms_list`. Requires Twilio credentials.",
    };
  },
};

export default smsMessagingSkill;
