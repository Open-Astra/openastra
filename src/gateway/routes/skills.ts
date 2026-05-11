import { Router } from "express";
import { getSkillManifests, getSkill } from "../../skills/registry.js";
import { getRegisteredToolCount } from "../../tools/index.js";
import { getCacheStats, clearCache } from "../../tools/cache.js";
import { etagCache } from "../middleware/etag-cache.js";
import { startSkillMetricsListener, getSkillMetrics } from "../../skills/metrics.js";
import { jwtAuth } from "../middleware/auth.js";
import { buildDependencyGraph, validateDependencyGraph } from "../../skills/dependency-graph.js";

// Start metrics listener when this module is loaded
startSkillMetricsListener();

// ── Skill Catalog REST Router ─────────────────────────────────────
// Public catalog of available skills and their tools.

export function createSkillRouter(): Router {
  const router = Router();

  // GET /skills/graph — dependency graph for dashboard visualization (Feature 29)
  router.get("/graph", etagCache({ maxAge: 30 }), (_req, res) => {
    const graph = buildDependencyGraph();
    res.json(graph);
  });

  // GET /skills/graph/validate — validate the dependency graph (Feature 29)
  router.get("/graph/validate", etagCache({ maxAge: 30 }), (_req, res) => {
    const result = validateDependencyGraph();
    res.json(result);
  });

  // GET /skills — list all registered skills (ETag cached)
  router.get("/", etagCache({ maxAge: 60 }), (_req, res) => {
    const manifests = getSkillManifests();

    res.json({
      skillCount: manifests.length,
      toolCount: getRegisteredToolCount(),
      skills: manifests.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        version: m.version,
        tools: m.tools,
        configFields: m.configFields,
      })),
    });
  });

  // GET /skills/:id/metrics — performance metrics for a skill (last 30 days)
  router.get("/:id/metrics", jwtAuth(), async (req, res) => {
    const id = String(req.params.id);
    if (!getSkill(id)) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    try {
      const metrics = await getSkillMetrics(id);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: "Failed to retrieve metrics" });
    }
  });

  // GET /skills/:id — get details for a specific skill (ETag cached)
  router.get("/:id", etagCache({ maxAge: 60 }), (req, res) => {
    const skill = getSkill(String(req.params.id));
    if (!skill) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const promptCtx = skill.getPromptContext?.();

    res.json({
      id: skill.manifest.id,
      name: skill.manifest.name,
      description: skill.manifest.description,
      category: skill.manifest.category,
      version: skill.manifest.version,
      tools: skill.manifest.tools,
      configFields: skill.manifest.configFields,
      instructions: promptCtx?.instructions ?? null,
    });
  });

  // GET /skills/cache/stats — tool result cache statistics (requires auth)
  router.get("/cache/stats", jwtAuth(), (_req, res) => {
    res.json(getCacheStats());
  });

  // POST /skills/cache/clear — clear tool result cache (requires auth)
  router.post("/cache/clear", jwtAuth(), (req, res) => {
    const toolName = req.query.tool as string | undefined;
    const cleared = clearCache(toolName);
    res.json({ cleared, tool: toolName ?? "all" });
  });

  return router;
}
