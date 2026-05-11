import { Router } from "express";
import { z } from "zod";
import {
  dailyMemoryCache,
  graphEntityCache,
  userProfileCache,
} from "../../memory/l1-cache.js";

export function createMemoryL1CacheRouter(): Router {
  const router = Router();

  router.get("/stats", (_req, res) => {
    try {
      return res.json({
        dailyMemory: dailyMemoryCache.stats(),
        graphEntity: graphEntityCache.stats(),
        userProfile: userProfileCache.stats(),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  const InvalidateBody = z.object({
    prefix: z.string().optional(),
    cache: z.enum(["daily", "graph", "profile", "all"]).optional(),
  });

  router.delete("/invalidate", (req, res) => {
    try {
      const parsed = InvalidateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const { prefix, cache } = parsed.data;

      const cacheTarget = cache ?? "all";

      const targets: Array<{ invalidatePrefix(p: string): number; clear(): void }> = [];
      if (cacheTarget === "daily" || cacheTarget === "all") targets.push(dailyMemoryCache);
      if (cacheTarget === "graph" || cacheTarget === "all") targets.push(graphEntityCache);
      if (cacheTarget === "profile" || cacheTarget === "all") targets.push(userProfileCache);

      if (prefix) {
        for (const c of targets) c.invalidatePrefix(prefix);
      } else {
        for (const c of targets) c.clear();
      }

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
