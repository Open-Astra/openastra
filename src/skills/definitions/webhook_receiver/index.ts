import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Webhook Receiver Skill ──────────────────────────────────────────
// Register inbound webhook endpoints that trigger agent actions.
// Stores webhook definitions in Postgres, and events are logged
// for the agent to process on next interaction or via heartbeat.

const RegisterParams = z.object({
  name: z.string().describe("Webhook name (used in endpoint path)"),
  description: z.string().optional().describe("What this webhook does"),
  secret: z.string().optional().describe("Optional HMAC secret for signature verification"),
  autoRespond: z.boolean().default(false).describe("Auto-respond with agent on incoming webhook"),
});

const ListWebhooksParams = z.object({});

const GetEventsParams = z.object({
  webhookName: z.string().optional().describe("Filter by webhook name"),
  limit: z.number().int().min(1).max(50).default(10),
  unprocessedOnly: z.boolean().default(true),
});

const ENSURE_TABLES = `
CREATE TABLE IF NOT EXISTS inbound_webhooks (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  secret TEXT,
  auto_respond BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, name)
);
CREATE TABLE IF NOT EXISTS inbound_webhook_events (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER REFERENCES inbound_webhooks(id),
  uid TEXT NOT NULL,
  payload JSONB,
  headers JSONB,
  processed BOOLEAN DEFAULT FALSE,
  received_at TIMESTAMPTZ DEFAULT NOW()
)`;

const webhookReceiverSkill: SkillDefinition = {
  name: "webhook_receiver",
  version: "1.0.0",

  manifest: {
    id: "webhook_receiver",
    name: "Webhook Receiver",
    description: "Register inbound webhook endpoints that trigger agent actions. Events are stored for processing.",
    category: "execute",
    tools: ["webhook_register", "webhook_list", "webhook_events"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    let tablesReady = false;
    const ensureTables = async () => {
      if (tablesReady) return;
      await getPool().query(ENSURE_TABLES);
      tablesReady = true;
    };

    ctx.registerTool({
      name: "webhook_register",
      description: "Register an inbound webhook endpoint. Events sent to this endpoint will be stored for the agent.",
      parameters: RegisterParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const result = await getPool().query(
          `INSERT INTO inbound_webhooks (uid, name, description, secret, auto_respond)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (uid, name) DO UPDATE SET description = $3, secret = $4, auto_respond = $5
           RETURNING id`,
          [toolCtx.uid, params.name, params.description ?? null, params.secret ?? null, params.autoRespond],
        );

        const id = (result.rows[0] as { id: number }).id;
        return {
          success: true,
          webhookId: id,
          name: params.name,
          endpoint: `/webhooks/inbound/${params.name}`,
          note: "POST events to this endpoint. They will be stored and available via webhook_events.",
        };
      },
    });

    ctx.registerTool({
      name: "webhook_list",
      description: "List all registered inbound webhooks.",
      parameters: ListWebhooksParams,

      async execute(_params, toolCtx) {
        await ensureTables();
        const result = await getPool().query(
          `SELECT id, name, description, auto_respond, created_at FROM inbound_webhooks WHERE uid = $1 ORDER BY created_at DESC`,
          [toolCtx.uid],
        );

        return { count: result.rows.length, webhooks: result.rows };
      },
    });

    ctx.registerTool({
      name: "webhook_events",
      description: "Get recent inbound webhook events for processing.",
      parameters: GetEventsParams,

      async execute(params, toolCtx) {
        await ensureTables();
        const conditions = ["e.uid = $1"];
        const queryParams: unknown[] = [toolCtx.uid];
        let idx = 2;

        if (params.webhookName) {
          conditions.push(`w.name = $${idx}`);
          queryParams.push(params.webhookName);
          idx++;
        }

        if (params.unprocessedOnly) {
          conditions.push("e.processed = false");
        }

        queryParams.push(params.limit);
        const result = await getPool().query(
          `SELECT e.id, w.name as webhook_name, e.payload, e.headers, e.processed, e.received_at
           FROM inbound_webhook_events e
           JOIN inbound_webhooks w ON w.id = e.webhook_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY e.received_at DESC LIMIT $${idx}`,
          queryParams,
        );

        // Mark as processed
        if (result.rows.length > 0) {
          const ids = (result.rows as Array<{ id: number }>).map((r) => r.id);
          await getPool().query(
            `UPDATE inbound_webhook_events SET processed = true WHERE id = ANY($1)`,
            [ids],
          );
        }

        return { count: result.rows.length, events: result.rows };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "webhook_receiver",
      instructions: "You can manage inbound webhooks with `webhook_register` (create endpoint), `webhook_list` (view registered hooks), and `webhook_events` (get unprocessed events). Events are stored in Postgres.",
    };
  },
};

export default webhookReceiverSkill;
