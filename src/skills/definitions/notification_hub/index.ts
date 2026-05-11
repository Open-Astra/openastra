import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Notification Hub Skill ──────────────────────────────────────────
// Unified push notifications across multiple channels: FCM, email,
// SMS, Slack, and webhook. Single interface for all notification types.

const SendNotificationParams = z.object({
  channel: z.enum(["fcm", "email", "sms", "slack", "webhook"]).describe("Notification channel"),
  to: z.string().describe("Recipient (token, email, phone, channel ID, or URL)"),
  title: z.string().describe("Notification title"),
  body: z.string().describe("Notification body"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  data: z.record(z.string(), z.string()).optional().describe("Additional data payload"),
});

const BroadcastParams = z.object({
  channels: z.array(z.object({
    channel: z.enum(["fcm", "email", "sms", "slack", "webhook"]),
    to: z.string(),
  })).min(1).max(10).describe("List of channels and recipients"),
  title: z.string(),
  body: z.string(),
});

const notificationHubSkill: SkillDefinition = {
  name: "notification_hub",
  version: "1.0.0",

  manifest: {
    id: "notification_hub",
    name: "Notification Hub",
    description: "Unified push notifications: FCM, email, SMS, Slack, and webhook in one interface.",
    category: "communicate",
    tools: ["notify_send", "notify_broadcast"],
    configFields: [
      { name: "fcmKey", type: "string", required: false, description: "Firebase Cloud Messaging server key", envVar: "FCM_SERVER_KEY" },
      { name: "resendKey", type: "string", required: false, description: "Resend API key for email", envVar: "RESEND_API_KEY" },
      { name: "twilioSid", type: "string", required: false, description: "Twilio Account SID", envVar: "TWILIO_ACCOUNT_SID" },
      { name: "slackToken", type: "string", required: false, description: "Slack Bot Token", envVar: "SLACK_BOT_TOKEN" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const sendFCM = async (to: string, title: string, body: string, data?: Record<string, string>) => {
      const key = process.env.FCM_SERVER_KEY;
      if (!key) return { error: "FCM_SERVER_KEY not configured." };

      const res = await safeFetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: { "Authorization": `key=${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to, notification: { title, body }, data }),
        ssrfProtection: false,
      });

      return res.ok ? { success: true, channel: "fcm" } : { error: `FCM error ${res.status}` };
    };

    const sendEmail = async (to: string, title: string, body: string) => {
      const key = process.env.RESEND_API_KEY;
      if (!key) return { error: "RESEND_API_KEY not configured." };

      const res = await safeFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.NOTIFICATION_FROM_EMAIL ?? "notifications@astra.ai",
          to, subject: title, text: body,
        }),
        ssrfProtection: false,
      });

      return res.ok ? { success: true, channel: "email" } : { error: `Email error ${res.status}` };
    };

    const sendSMS = async (to: string, body: string) => {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_PHONE_NUMBER;
      if (!sid || !token || !from) return { error: "Twilio not configured." };

      const res = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
        ssrfProtection: false,
      });

      return res.ok ? { success: true, channel: "sms" } : { error: `SMS error ${res.status}` };
    };

    const sendSlack = async (channel: string, title: string, body: string) => {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return { error: "SLACK_BOT_TOKEN not configured." };

      const res = await safeFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text: `*${title}*\n${body}` }),
        ssrfProtection: false,
      });

      return res.ok ? { success: true, channel: "slack" } : { error: `Slack error ${res.status}` };
    };

    const sendWebhook = async (url: string, title: string, body: string, data?: Record<string, string>) => {
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, data, timestamp: new Date().toISOString() }),
      });

      return res.ok ? { success: true, channel: "webhook" } : { error: `Webhook error ${res.status}` };
    };

    ctx.registerTool({
      name: "notify_send",
      description: "Send a notification via a specific channel (FCM, email, SMS, Slack, or webhook).",
      parameters: SendNotificationParams,

      async execute(params, _toolCtx) {
        switch (params.channel) {
          case "fcm": return sendFCM(params.to, params.title, params.body, params.data as Record<string, string> | undefined);
          case "email": return sendEmail(params.to, params.title, params.body);
          case "sms": return sendSMS(params.to, `${params.title}: ${params.body}`);
          case "slack": return sendSlack(params.to, params.title, params.body);
          case "webhook": return sendWebhook(params.to, params.title, params.body, params.data as Record<string, string> | undefined);
        }
      },
    });

    ctx.registerTool({
      name: "notify_broadcast",
      description: "Send the same notification to multiple channels at once.",
      parameters: BroadcastParams,

      async execute(params, _toolCtx) {
        const results = await Promise.allSettled(
          params.channels.map(async (ch) => {
            switch (ch.channel) {
              case "fcm": return { channel: "fcm", ...await sendFCM(ch.to, params.title, params.body) };
              case "email": return { channel: "email", ...await sendEmail(ch.to, params.title, params.body) };
              case "sms": return { channel: "sms", ...await sendSMS(ch.to, `${params.title}: ${params.body}`) };
              case "slack": return { channel: "slack", ...await sendSlack(ch.to, params.title, params.body) };
              case "webhook": return { channel: "webhook", ...await sendWebhook(ch.to, params.title, params.body) };
            }
          }),
        );

        const delivered = results.filter((r) => r.status === "fulfilled" && (r.value as Record<string, unknown>).success).length;
        return {
          total: params.channels.length,
          delivered,
          failed: params.channels.length - delivered,
          results: results.map((r) => r.status === "fulfilled" ? r.value : { error: String((r as PromiseRejectedResult).reason) }),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "notification_hub",
      instructions: "You can send notifications with `notify_send` (single channel: FCM/email/SMS/Slack/webhook) and `notify_broadcast` (multiple channels at once). Configure credentials via env vars.",
    };
  },
};

export default notificationHubSkill;
