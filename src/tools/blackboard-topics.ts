import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── blackboard_topic ────────────────────────────────────────────────
// Named topic/channel system for blackboard. Agents can create topics,
// subscribe/unsubscribe, publish to specific topics, and read only
// from their subscribed topics. Enables selective information flow
// within swarms.

const BlackboardTopicParams = z.object({
  action: z
    .enum(["create", "subscribe", "unsubscribe", "publish", "read", "list", "list_subscribers"])
    .describe("Action: create topic, subscribe, unsubscribe, publish message, read messages, list topics, or list subscribers"),
  swarm_id: z.string().describe("Swarm ID"),
  topic: z.string().optional().describe("Topic name (for create/subscribe/unsubscribe/publish/read)"),
  content: z.string().optional().describe("Content to publish (for publish action)"),
  description: z.string().optional().describe("Topic description (for create action)"),
  agent_role: z.string().optional().describe("Agent role for subscription (defaults to current agent)"),
});

registerTool({
  name: "blackboard_topic",
  description:
    "Named topic/channel system for swarm blackboards. Create topics, subscribe agents, publish/read messages selectively. Enables structured information flow between swarm agents.",
  parameters: BlackboardTopicParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "create": {
        if (!params.topic) return { error: "topic name required" };

        const id = randomUUID();
        await pool.query(
          `INSERT INTO blackboard_topics (id, swarm_id, name, description, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (swarm_id, name) DO NOTHING`,
          [id, params.swarm_id, params.topic, params.description ?? "", ctx.uid],
        );

        return {
          result: "Topic created",
          topicId: id,
          topic: params.topic,
          swarmId: params.swarm_id,
        };
      }

      case "subscribe": {
        if (!params.topic) return { error: "topic name required" };
        const role = params.agent_role ?? ctx.agentId;

        await pool.query(
          `INSERT INTO blackboard_subscriptions (swarm_id, topic_name, agent_role, subscribed_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (swarm_id, topic_name, agent_role) DO NOTHING`,
          [params.swarm_id, params.topic, role],
        );

        return {
          result: "Subscribed",
          topic: params.topic,
          agentRole: role,
        };
      }

      case "unsubscribe": {
        if (!params.topic) return { error: "topic name required" };
        const role = params.agent_role ?? ctx.agentId;

        await pool.query(
          `DELETE FROM blackboard_subscriptions
           WHERE swarm_id = $1 AND topic_name = $2 AND agent_role = $3`,
          [params.swarm_id, params.topic, role],
        );

        return {
          result: "Unsubscribed",
          topic: params.topic,
          agentRole: role,
        };
      }

      case "publish": {
        if (!params.topic || !params.content) {
          return { error: "topic and content required for publish" };
        }

        // Verify topic exists
        const { rows: topicRows } = await pool.query<{ id: string }>(
          "SELECT id FROM blackboard_topics WHERE swarm_id = $1 AND name = $2",
          [params.swarm_id, params.topic],
        );

        if (topicRows.length === 0) {
          return { error: `Topic "${params.topic}" not found in swarm ${params.swarm_id}` };
        }

        const messageId = randomUUID();
        await pool.query(
          `INSERT INTO blackboard_topic_messages (id, swarm_id, topic_name, agent_role, content, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [messageId, params.swarm_id, params.topic, params.agent_role ?? ctx.agentId, params.content],
        );

        // Get subscriber count
        const { rows: subRows } = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM blackboard_subscriptions
           WHERE swarm_id = $1 AND topic_name = $2`,
          [params.swarm_id, params.topic],
        );

        return {
          result: "Published",
          messageId,
          topic: params.topic,
          subscriberCount: parseInt(subRows[0]?.count ?? "0"),
        };
      }

      case "read": {
        if (!params.topic) return { error: "topic name required" };

        // Check subscription
        const role = params.agent_role ?? ctx.agentId;
        const { rows: subCheck } = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM blackboard_subscriptions
           WHERE swarm_id = $1 AND topic_name = $2 AND agent_role = $3`,
          [params.swarm_id, params.topic, role],
        );

        const isSubscribed = parseInt(subCheck[0]?.count ?? "0") > 0;

        // Read messages (subscribers see all; non-subscribers get a warning)
        const { rows: messages } = await pool.query<{
          id: string;
          agent_role: string;
          content: string;
          created_at: string;
        }>(
          `SELECT id, agent_role, content, created_at
           FROM blackboard_topic_messages
           WHERE swarm_id = $1 AND topic_name = $2
           ORDER BY created_at ASC LIMIT 50`,
          [params.swarm_id, params.topic],
        );

        return {
          result: `${messages.length} message(s) in topic "${params.topic}"`,
          topic: params.topic,
          subscribed: isSubscribed,
          warning: isSubscribed ? undefined : "Not subscribed to this topic",
          messages: messages.map((m) => ({
            id: m.id,
            agentRole: m.agent_role,
            content: m.content,
            createdAt: m.created_at,
          })),
        };
      }

      case "list": {
        const { rows } = await pool.query<{
          id: string;
          name: string;
          description: string;
          created_at: string;
          message_count: string;
        }>(
          `SELECT t.id, t.name, t.description, t.created_at,
                  COALESCE(m.cnt, 0)::text AS message_count
           FROM blackboard_topics t
           LEFT JOIN (
             SELECT topic_name, COUNT(*) AS cnt
             FROM blackboard_topic_messages WHERE swarm_id = $1
             GROUP BY topic_name
           ) m ON m.topic_name = t.name
           WHERE t.swarm_id = $1
           ORDER BY t.created_at ASC`,
          [params.swarm_id],
        );

        return {
          result: `${rows.length} topic(s)`,
          swarmId: params.swarm_id,
          topics: rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            messageCount: parseInt(r.message_count),
            createdAt: r.created_at,
          })),
        };
      }

      case "list_subscribers": {
        if (!params.topic) return { error: "topic name required" };

        const { rows } = await pool.query<{
          agent_role: string;
          subscribed_at: string;
        }>(
          `SELECT agent_role, subscribed_at FROM blackboard_subscriptions
           WHERE swarm_id = $1 AND topic_name = $2
           ORDER BY subscribed_at ASC`,
          [params.swarm_id, params.topic],
        );

        return {
          result: `${rows.length} subscriber(s)`,
          topic: params.topic,
          subscribers: rows.map((r) => ({
            agentRole: r.agent_role,
            subscribedAt: r.subscribed_at,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
