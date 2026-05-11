import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── knowledge_inject ────────────────────────────────────────────────
// External knowledge injection hooks. Push real-time data (RSS feeds,
// webhooks, manual entries) into memory tiers with content-hash
// deduplication and relevance scoring.

const KnowledgeInjectParams = z.object({
  action: z
    .enum(["inject", "bulk_inject", "list", "configure_source", "list_sources"])
    .describe("Action: inject single item, bulk inject, list recent injections, configure a source, or list sources"),
  content: z.string().optional().describe("Content to inject (for inject action)"),
  items: z
    .array(z.object({
      content: z.string().describe("Content to inject"),
      source: z.string().optional().describe("Source identifier"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Additional metadata"),
    }))
    .optional()
    .describe("Items for bulk injection"),
  source: z.string().optional().describe("Source identifier (e.g., 'rss:techcrunch', 'webhook:github')"),
  target_tier: z
    .enum(["daily", "graph", "workspace"])
    .default("daily")
    .describe("Which memory tier to inject into"),
  category: z
    .enum(["decision", "outcome", "strategy", "note", "interaction"])
    .default("note")
    .describe("Memory category (for daily tier)"),
  source_config: z
    .object({
      name: z.string().describe("Source name"),
      type: z.enum(["rss", "webhook", "api", "manual"]).describe("Source type"),
      url: z.string().optional().describe("Source URL"),
      schedule: z.string().optional().describe("Cron schedule for polling"),
      active: z.boolean().default(true),
    })
    .optional()
    .describe("Source configuration (for configure_source)"),
});

registerTool({
  name: "knowledge_inject",
  description:
    "Inject external knowledge into memory tiers. Push data from RSS feeds, webhooks, or manual entries with content-hash deduplication and relevance scoring.",
  parameters: KnowledgeInjectParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "inject": {
        if (!params.content) return { error: "content required for inject" };

        const result = await injectItem(
          pool,
          ctx.uid,
          params.content,
          params.source ?? "manual",
          params.target_tier,
          params.category,
          ctx.workspaceId,
        );

        return result;
      }

      case "bulk_inject": {
        if (!params.items || params.items.length === 0) {
          return { error: "items required for bulk_inject" };
        }

        const results = {
          total: params.items.length,
          injected: 0,
          duplicates: 0,
          errors: 0,
        };

        for (const item of params.items) {
          const result = await injectItem(
            pool,
            ctx.uid,
            item.content,
            item.source ?? params.source ?? "manual",
            params.target_tier,
            params.category,
            ctx.workspaceId,
            item.metadata,
          );

          if ("duplicate" in result && result.duplicate) {
            results.duplicates++;
          } else if ("error" in result) {
            results.errors++;
          } else {
            results.injected++;
          }
        }

        return { result: "Bulk injection complete", ...results };
      }

      case "list": {
        const { rows } = await pool.query<{
          id: string;
          value: {
            content: string;
            source: string;
            tier: string;
            relevance: number;
            injectedAt: number;
          };
        }>(
          `SELECT id, value FROM knowledge_injections
           WHERE uid = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid],
        );

        return {
          result: `${rows.length} recent injection(s)`,
          injections: rows.map((r) => ({
            id: r.id,
            source: r.value.source,
            tier: r.value.tier,
            relevance: r.value.relevance,
            contentPreview: r.value.content.slice(0, 200),
            injectedAt: new Date(r.value.injectedAt).toISOString(),
          })),
        };
      }

      case "configure_source": {
        if (!params.source_config) return { error: "source_config required" };

        const id = randomUUID();
        await pool.query(
          `INSERT INTO knowledge_sources (id, uid, value, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW(), NOW())
           ON CONFLICT (uid, (value->>'name'))
           DO UPDATE SET value = $3::jsonb, updated_at = NOW()`,
          [id, ctx.uid, JSON.stringify(params.source_config)],
        );

        return {
          result: "Source configured",
          sourceId: id,
          source: params.source_config,
        };
      }

      case "list_sources": {
        const { rows } = await pool.query<{
          id: string;
          value: { name: string; type: string; url: string; schedule: string; active: boolean };
        }>(
          "SELECT id, value FROM knowledge_sources WHERE uid = $1",
          [ctx.uid],
        );

        return {
          result: `${rows.length} source(s)`,
          sources: rows.map((r) => ({
            id: r.id,
            ...r.value,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

async function injectItem(
  pool: ReturnType<typeof getPool>,
  uid: string,
  content: string,
  source: string,
  targetTier: string,
  category: string,
  workspaceId?: string,
  metadata?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Content-hash dedup
  const contentHash = createHash("md5").update(content).digest("hex");

  const { rows: existing } = await pool.query<{ id: string }>(
    "SELECT id FROM knowledge_injections WHERE uid = $1 AND content_hash = $2",
    [uid, contentHash],
  );

  if (existing.length > 0) {
    return { duplicate: true, existingId: existing[0]!.id, message: "Content already injected" };
  }

  // Compute relevance score (simple heuristic based on content quality)
  const relevance = computeRelevance(content);

  const id = randomUUID();
  const value = {
    content,
    source,
    tier: targetTier,
    category,
    relevance,
    metadata: metadata ?? {},
    injectedAt: Date.now(),
  };

  // Store injection record
  await pool.query(
    `INSERT INTO knowledge_injections (id, uid, content_hash, value, created_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())`,
    [id, uid, contentHash, JSON.stringify(value)],
  );

  // Actually inject into the target tier
  switch (targetTier) {
    case "daily": {
      const today = new Date().toISOString().split("T")[0];
      const entry = {
        timestamp: Date.now(),
        category,
        content: `[Injected from ${source}] ${content}`,
        metadata: { source, injectionId: id, ...metadata },
      };

      await pool.query(
        `INSERT INTO daily_memory (user_id, date, entries)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, workspace_id, date)
         DO UPDATE SET entries = daily_memory.entries || $4::jsonb, updated_at = NOW()`,
        [uid, today, JSON.stringify([entry]), JSON.stringify(entry)],
      );
      break;
    }

    case "workspace": {
      if (workspaceId) {
        await pool.query(
          `INSERT INTO workspace_knowledge (id, workspace_id, value, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
          [id, workspaceId, JSON.stringify({
            category: "injected",
            title: `[${source}] ${content.slice(0, 80)}`,
            content,
            metadata: { source, relevance },
          })],
        );
      }
      break;
    }
  }

  return {
    result: "Knowledge injected",
    id,
    tier: targetTier,
    relevance,
    contentHash,
  };
}

function computeRelevance(content: string): number {
  let score = 0.5;

  // Length bonus (medium-length content is more likely relevant)
  if (content.length > 50 && content.length < 5000) score += 0.1;
  if (content.length > 200) score += 0.1;

  // Structure bonus (contains structured data indicators)
  if (/\d+/.test(content)) score += 0.05;
  if (/\b(?:because|therefore|conclusion|result)\b/i.test(content)) score += 0.1;
  if (/\b(?:http|https):\/\//.test(content)) score += 0.05;

  return Math.min(1, Math.round(score * 100) / 100);
}
