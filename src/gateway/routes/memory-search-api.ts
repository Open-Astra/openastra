// Mount: app.use("/memory/search", jwtAuth(), workspaceResolver(), createMemorySearchApiRouter())

import { Router } from "express";
import { z } from "zod";
import { searchAllTiers } from "../../memory/tiered-search.js";
import { MemoryProfileConfigSchema } from "../../memory/profiles.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

const TierEnum = z.enum(["session", "daily", "profile", "graph", "procedural", "rag"]);

const SearchBody = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional(),
  tiers: z.array(TierEnum).optional(),
});

export function createMemorySearchApiRouter(): Router {
  const router = Router();

  // POST /memory/search
  // Body: { query, limit?, tiers?: ('session'|'daily'|'profile'|'graph'|'procedural'|'rag')[] }
  // uid is derived from the authenticated JWT — never from the request body.
  router.post("/", async (req, res) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.format() });
      return;
    }

    const { query, limit = 10, tiers } = parsed.data;
    const uid = (req as unknown as AuthenticatedRequest).uid;

    // Build a MemoryProfileConfig that restricts which tiers to search
    const profileOverride = tiers
      ? MemoryProfileConfigSchema.parse({
          tiersEnabled: {
            session: tiers.includes("session"),
            daily: tiers.includes("daily"),
            profile: tiers.includes("profile"),
            graph: tiers.includes("graph"),
            procedural: tiers.includes("procedural"),
            rag: tiers.includes("rag"),
          },
          maxContextChunks: limit,
          minRelevanceScore: 0,
        })
      : undefined;

    try {
      const results = await searchAllTiers(uid, query, limit, profileOverride);

      // Group results by tier for the API response
      const byTier: Record<string, Array<{ content: string; score: number; source: string; metadata?: Record<string, unknown> }>> = {};
      for (const result of results) {
        const tier = result.tier;
        if (!byTier[tier]) byTier[tier] = [];
        byTier[tier]!.push({
          content: result.content,
          score: result.score,
          source: result.source,
          metadata: result.metadata,
        });
      }

      res.json({
        query,
        uid,
        totalResults: results.length,
        results,
        byTier,
      });
    } catch (err) {
      console.error("[memory-search-api] Error:", err);
      res.status(500).json({ error: "Memory search failed" });
    }
  });

  return router;
}
