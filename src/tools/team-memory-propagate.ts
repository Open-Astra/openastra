import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── team_memory_propagate ──────────────────────────────────────────
// Cross-user learning propagation within a workspace. When one user's
// agent discovers something valuable, this tool promotes it to shared
// workspace memory so all team members benefit. Uses relevance scoring,
// deduplication, and configurable auto-propagation thresholds.
//
// Flow: Individual memory → Relevance check → Dedup → Workspace memory
//
// Also supports "pull" mode: agents can request learnings from the
// team that are relevant to their current task.

const TeamMemoryPropagateParams = z.object({
  action: z
    .enum(["promote", "pull", "auto_scan", "configure", "activity", "retract"])
    .describe(
      "Action: promote individual memory to team, pull relevant team learnings, " +
      "auto-scan for promotable entries, configure thresholds, view activity, or retract a promotion",
    ),
  content: z
    .string()
    .optional()
    .describe("Content to promote to team memory (for promote action)"),
  source_tier: z
    .enum(["daily", "profile", "graph"])
    .optional()
    .describe("Which personal memory tier the content came from"),
  source_id: z
    .string()
    .optional()
    .describe("ID of the source memory entry"),
  category: z
    .enum(["decision", "adr", "standup", "retrospective", "note", "knowledge", "discovery", "pattern", "warning"])
    .default("knowledge")
    .describe("Category tag for the team memory entry"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags for searchability"),
  query: z
    .string()
    .optional()
    .describe("Search query for pulling relevant team learnings (for pull action)"),
  relevance_threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum relevance score for pull results (default 0.5)"),
  auto_threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Auto-promotion threshold (for configure action, default 0.7)"),
  promotion_id: z
    .string()
    .optional()
    .describe("Promotion ID to retract (for retract action)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
});

registerTool({
  name: "team_memory_propagate",
  description:
    "Cross-user learning propagation for shared workspaces. Promote individual discoveries " +
    "to team memory, pull relevant team learnings for current tasks, auto-scan personal " +
    "memory for promotable entries, and track propagation activity. Ensures all team members " +
    "and their agents benefit from each other's discoveries.",
  parameters: TeamMemoryPropagateParams,

  async execute(params, ctx) {
    const pool = getPool();
    const workspaceId = ctx.workspaceId ?? "default";

    switch (params.action) {
      // ── Promote: push individual learning to team ──────────────
      case "promote": {
        if (!params.content) return { error: "content required for promote" };

        // Content-hash dedup check
        const contentHash = simpleHash(params.content);
        const { rows: existing } = await pool.query<{ id: string }>(
          `SELECT id FROM workspace_memory
           WHERE workspace_id = $1
             AND content = $2
           LIMIT 1`,
          [workspaceId, params.content],
        );

        if (existing.length > 0) {
          return {
            result: "Already exists in team memory (deduplicated)",
            existingId: existing[0]!.id,
          };
        }

        // Write to workspace memory
        const id = randomUUID();
        const tags = [
          ...(params.tags ?? []),
          `promoted-by:${ctx.uid}`,
          `source-tier:${params.source_tier ?? "unknown"}`,
        ];

        // Try to generate embedding for semantic search
        let embedding: number[] | null = null;
        try {
          const { generateEmbedding } = await import("../memory/embeddings.js");
          embedding = await generateEmbedding(params.content);
        } catch {
          // Proceed without embedding
        }

        await pool.query(
          `INSERT INTO workspace_memory (id, workspace_id, author_id, category, content, tags, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            workspaceId,
            ctx.uid,
            params.category,
            params.content,
            tags,
            embedding ? JSON.stringify(embedding) : null,
          ],
        );

        // Record propagation event
        const promotionId = randomUUID();
        await pool.query(
          `INSERT INTO team_propagation_log (id, uid, workspace_id, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [promotionId, ctx.uid, workspaceId, JSON.stringify({
            type: "promote",
            memoryId: id,
            contentHash,
            sourceTier: params.source_tier,
            sourceId: params.source_id,
            category: params.category,
            contentPreview: params.content.slice(0, 200),
            agentId: ctx.agentId,
          })],
        );

        return {
          result: "Learning promoted to team memory",
          promotionId,
          memoryId: id,
          workspace: workspaceId,
          category: params.category,
          tags,
        };
      }

      // ── Pull: retrieve relevant team learnings ─────────────────
      case "pull": {
        if (!params.query) return { error: "query required for pull" };

        const threshold = params.relevance_threshold ?? 0.5;

        // Try semantic search first
        let results: Array<{
          id: string;
          category: string;
          content: string;
          tags: string[];
          score: number;
          authorId: string;
          createdAt: string;
        }> = [];

        try {
          const { generateEmbedding } = await import("../memory/embeddings.js");
          const queryEmbedding = await generateEmbedding(params.query);

          const { rows } = await pool.query<{
            id: string;
            category: string;
            content: string;
            tags: string[];
            score: number;
            author_id: string;
            created_at: string;
          }>(
            `SELECT id, category, content, tags, author_id,
                    1 - (embedding <=> $1::vector) AS score,
                    created_at
             FROM workspace_memory
             WHERE workspace_id = $2 AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector ASC
             LIMIT $3`,
            [JSON.stringify(queryEmbedding), workspaceId, params.limit],
          );

          results = rows
            .filter((r) => r.score >= threshold)
            .map((r) => ({
              id: r.id,
              category: r.category,
              content: r.content,
              tags: r.tags,
              score: Math.round(r.score * 1000) / 1000,
              authorId: r.author_id,
              createdAt: r.created_at,
            }));
        } catch {
          // Fall back to text search
          const { rows } = await pool.query<{
            id: string;
            category: string;
            content: string;
            tags: string[];
            author_id: string;
            created_at: string;
          }>(
            `SELECT id, category, content, tags, author_id, created_at
             FROM workspace_memory
             WHERE workspace_id = $1 AND content ILIKE $2
             ORDER BY created_at DESC LIMIT $3`,
            [workspaceId, `%${params.query}%`, params.limit],
          );

          results = rows.map((r) => ({
            id: r.id,
            category: r.category,
            content: r.content,
            tags: r.tags,
            score: 0,
            authorId: r.author_id,
            createdAt: r.created_at,
          }));
        }

        // Exclude entries authored by the requesting user (they already know these)
        const fromOthers = results.filter((r) => r.authorId !== ctx.uid);
        const fromSelf = results.filter((r) => r.authorId === ctx.uid);

        return {
          result: `${fromOthers.length} team learning(s) from other members, ${fromSelf.length} from you`,
          fromTeam: fromOthers,
          fromSelf: fromSelf.slice(0, 3), // brief reminder of own contributions
        };
      }

      // ── Auto-scan: find promotable entries in personal memory ──
      case "auto_scan": {
        const threshold = params.auto_threshold ?? 0.7;

        // Scan recent daily entries for high-value content
        const { rows: recentDaily } = await pool.query<{
          date: string;
          entries: Array<{
            content: string;
            type?: string;
            importance?: string;
          }>;
        }>(
          `SELECT date, entries FROM daily_memory
           WHERE user_id = $1 ORDER BY date DESC LIMIT 3`,
          [ctx.uid],
        );

        const candidates: Array<{
          tier: string;
          content: string;
          score: number;
          reason: string;
        }> = [];

        // Score daily entries by type and length
        for (const row of recentDaily) {
          for (const entry of row.entries) {
            let score = 0.3; // base
            const content = entry.content ?? "";

            // Boost for decision-like content
            if (/decided|agreed|concluded|resolved|chose/i.test(content)) score += 0.3;
            // Boost for discovery patterns
            if (/found|discovered|realized|learned|noticed/i.test(content)) score += 0.2;
            // Boost for warning patterns
            if (/warning|careful|avoid|don't|issue|bug/i.test(content)) score += 0.2;
            // Boost for longer, more detailed entries
            if (content.length > 200) score += 0.1;
            // Cap at 1.0
            score = Math.min(1.0, score);

            if (score >= threshold) {
              // Dedup check against existing workspace memory
              const { rows: exists } = await pool.query<{ id: string }>(
                "SELECT id FROM workspace_memory WHERE workspace_id = $1 AND content = $2 LIMIT 1",
                [workspaceId, content],
              );

              if (exists.length === 0) {
                candidates.push({
                  tier: "daily",
                  content: content.slice(0, 500),
                  score: Math.round(score * 100) / 100,
                  reason: score >= 0.8 ? "High-value discovery or decision" : "Potentially useful team knowledge",
                });
              }
            }
          }
        }

        // Scan graph entities for broadly relevant ones
        const { rows: graphEntities } = await pool.query<{
          id: string;
          name: string;
          entity_type: string;
          summary: string;
        }>(
          `SELECT id, name, entity_type, summary FROM graph_entities
           WHERE uid = $1 AND reinforcement_score > 0.7
           ORDER BY reinforcement_score DESC LIMIT 10`,
          [ctx.uid],
        );

        for (const entity of graphEntities) {
          const content = `${entity.entity_type}: ${entity.name} — ${entity.summary}`;
          const { rows: exists } = await pool.query<{ id: string }>(
            "SELECT id FROM workspace_memory WHERE workspace_id = $1 AND content = $2 LIMIT 1",
            [workspaceId, content],
          );

          if (exists.length === 0) {
            candidates.push({
              tier: "graph",
              content: content.slice(0, 500),
              score: 0.75,
              reason: "High-reinforcement graph entity",
            });
          }
        }

        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);

        return {
          result: `${candidates.length} candidate(s) for team promotion`,
          threshold,
          candidates: candidates.slice(0, 20),
          hint: "Use 'promote' action with the content to push to team memory",
        };
      }

      // ── Configure: set auto-propagation thresholds ─────────────
      case "configure": {
        const threshold = params.auto_threshold ?? 0.7;

        await pool.query(
          `INSERT INTO team_propagation_config (uid, workspace_id, value, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (uid, workspace_id) DO UPDATE SET value = $3::jsonb, updated_at = NOW()`,
          [ctx.uid, workspaceId, JSON.stringify({
            autoThreshold: threshold,
            relevanceThreshold: params.relevance_threshold ?? 0.5,
            maxAutoPromotionsPerDay: 10,
            excludeCategories: [],
          })],
        );

        return {
          result: "Team propagation configured",
          workspace: workspaceId,
          autoThreshold: threshold,
          relevanceThreshold: params.relevance_threshold ?? 0.5,
        };
      }

      // ── Activity: view recent propagation events ───────────────
      case "activity": {
        const { rows } = await pool.query<{
          id: string;
          uid: string;
          value: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, uid, value, created_at FROM team_propagation_log
           WHERE workspace_id = $1
           ORDER BY created_at DESC LIMIT $2`,
          [workspaceId, params.limit],
        );

        // Group by user
        const byUser = new Map<string, number>();
        for (const r of rows) {
          byUser.set(r.uid, (byUser.get(r.uid) ?? 0) + 1);
        }

        return {
          result: `${rows.length} propagation event(s)`,
          workspace: workspaceId,
          events: rows.map((r) => ({
            id: r.id,
            userId: r.uid,
            ...r.value,
            createdAt: r.created_at,
          })),
          contributionsByUser: Object.fromEntries(byUser),
        };
      }

      // ── Retract: remove a previously promoted entry ────────────
      case "retract": {
        if (!params.promotion_id) return { error: "promotion_id required for retract" };

        // Find the promotion record
        const { rows } = await pool.query<{
          value: { memoryId: string; type: string };
        }>(
          "SELECT value FROM team_propagation_log WHERE id = $1 AND uid = $2",
          [params.promotion_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Promotion not found or not yours to retract" };
        const { memoryId } = rows[0]!.value;

        // Delete from workspace memory
        await pool.query(
          "DELETE FROM workspace_memory WHERE id = $1 AND workspace_id = $2",
          [memoryId, workspaceId],
        );

        // Log retraction
        await pool.query(
          `INSERT INTO team_propagation_log (id, uid, workspace_id, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [randomUUID(), ctx.uid, workspaceId, JSON.stringify({
            type: "retract",
            originalPromotionId: params.promotion_id,
            memoryId,
          })],
        );

        return {
          result: "Promotion retracted",
          promotionId: params.promotion_id,
          removedMemoryId: memoryId,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}
