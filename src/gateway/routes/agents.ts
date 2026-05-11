import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { diffAgentVersions } from "../../agents/diff.js";
import { AgentConfig } from "../../agents/types.js";
import {
  createAgentConfig,
  getAgentConfigs,
  getAgentConfigById,
  updateAgentConfig,
  deleteAgentConfig,
  listAgentVersions,
  getAgentVersion,
  updateVersionLabel,
} from "../../agents/config-store.js";
import { getSkillToolNames, getAllSkills } from "../../skills/registry.js";
import { etagCache } from "../middleware/etag-cache.js";

// ── Request Validation ──────────────────────────────────────────────

const CreateAgentBody = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(100),
  tier: z.enum(["free", "premium", "internal"]).default("free"),
  model: z.object({
    provider: z.enum(["grok", "openai", "gemini", "claude", "vllm"]),
    modelId: z.string(),
    endpoint: z.string().url().optional(),
    maxContextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).default(0.7),
  }),
  systemPromptTemplate: z.string().min(1),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()).default([]),
  }),
  skills: z.array(z.string()).default([]),
  session: z.object({
    dailyResetHour: z.number().int().min(0).max(23).default(4),
    idleTimeoutMinutes: z.number().int().positive().default(120),
    maxContextMessages: z.number().int().positive().default(50),
  }).default({ dailyResetHour: 4, idleTimeoutMinutes: 120, maxContextMessages: 50 }),
  spawn: z.object({
    enabled: z.boolean().default(false),
    allowedTargets: z.array(z.string()).default([]),
    maxDepth: z.number().int().min(1).max(3).default(2),
  }).default({ enabled: false, allowedTargets: [], maxDepth: 2 }),
});

const PatchVersionLabelBody = z.object({
  label: z.string().max(128).nullable(),
});

const UpdateAgentBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  tier: z.enum(["free", "premium", "internal"]).optional(),
  model: z.object({
    provider: z.enum(["grok", "openai", "gemini", "claude", "vllm"]),
    modelId: z.string(),
    endpoint: z.string().url().optional(),
    maxContextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).default(0.7),
  }).optional(),
  systemPromptTemplate: z.string().min(1).optional(),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()).default([]),
    maxToolCallsPerRound: z.number().int().positive().default(8),
  }).optional(),
  skills: z.array(z.string()).optional(),
  session: z.object({
    dailyResetHour: z.number().int().min(0).max(23).default(4),
    idleTimeoutMinutes: z.number().int().positive().default(120),
    maxContextMessages: z.number().int().positive().default(50),
  }).optional(),
  spawn: z.object({
    enabled: z.boolean().default(false),
    allowedTargets: z.array(z.string()).default([]),
    maxDepth: z.number().int().min(1).max(3).default(2),
  }).optional(),
});

// ── Agents Router ───────────────────────────────────────────────────

export function createAgentsRouter(): Router {
  const router = Router();

  // POST /agents — create agent
  router.post("/", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required to create an agent" });
      return;
    }

    const parsed = CreateAgentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const config: AgentConfig = parsed.data as AgentConfig;
      await createAgentConfig(config, workspaceId, uid);
      res.status(201).json({ agent: config });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("duplicate key")) {
        res.status(409).json({ error: `Agent "${parsed.data.id}" already exists` });
        return;
      }
      console.error("[agents] Create error:", err);
      res.status(500).json({ error: "Failed to create agent" });
    }
  });

  // GET /agents — list agents for current workspace (ETag cached)
  router.get("/", etagCache({ maxAge: 30 }), async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;

    if (!workspaceId) {
      res.json({ agents: [] });
      return;
    }

    try {
      const agents = await getAgentConfigs(workspaceId);
      res.json({ agents });
    } catch (err) {
      console.error("[agents] List error:", err);
      res.status(500).json({ error: "Failed to list agents" });
    }
  });

  // GET /agents/:id — get agent config (ETag cached)
  router.get("/:id", etagCache({ maxAge: 30 }), async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId ?? null;

    try {
      const config = await getAgentConfigById(id, workspaceId);
      if (!config) {
        res.status(404).json({ error: `Agent "${id}" not found` });
        return;
      }
      res.json({ agent: config });
    } catch (err) {
      console.error("[agents] Get error:", err);
      res.status(500).json({ error: "Failed to get agent" });
    }
  });

  // GET /agents/:id/capabilities — capability introspection (rec 19)
  // Returns the full resolved capability set for an agent: effective tool
  // list (after skill expansion), spawn permissions, and model config.
  router.get("/:id/capabilities", async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId ?? null;

    try {
      const config = await getAgentConfigById(id, workspaceId);
      if (!config) {
        res.status(404).json({ error: `Agent "${id}" not found` });
        return;
      }

      // Expand skill tool names into the allow set (mirrors what loop.ts does)
      const skillTools = getSkillToolNames(config.skills ?? []);
      const effectiveTools = [...new Set([...config.tools.allow, ...skillTools])];

      // Describe which skills are active and what tools each contributes
      const allSkills = getAllSkills();
      const activeSkills = (config.skills ?? []).map((skillId) => {
        const skill = allSkills.get(skillId);
        return {
          id: skillId,
          tools: skill?.manifest.tools ?? [],
          category: skill?.manifest.category ?? "unknown",
        };
      });

      res.json({
        agentId: id,
        allowedTools: effectiveTools,
        deniedTools: config.tools.deny,
        activeSkills,
        spawnConfig: {
          enabled: config.spawn.enabled,
          allowedTargets: config.spawn.allowedTargets,
          maxDepth: config.spawn.maxDepth,
        },
        modelConfig: {
          provider: config.model.provider,
          modelId: config.model.modelId,
          maxContextTokens: config.model.maxContextTokens,
          maxOutputTokens: config.model.maxOutputTokens,
        },
        sessionConfig: config.session,
      });
    } catch (err) {
      console.error("[agents] Capabilities error:", err);
      res.status(500).json({ error: "Failed to get agent capabilities" });
    }
  });

  // PUT /agents/:id — update agent config
  router.put("/:id", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId ?? null;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required to update an agent" });
      return;
    }

    const parsed = UpdateAgentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const updated = await updateAgentConfig(id, parsed.data, uid, workspaceId);
      if (!updated) {
        res.status(404).json({ error: `Agent "${id}" not found` });
        return;
      }
      res.json({ agent: updated });
    } catch (err) {
      console.error("[agents] Update error:", err);
      res.status(500).json({ error: "Failed to update agent" });
    }
  });

  // DELETE /agents/:id — delete agent config
  router.delete("/:id", async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const workspaceId = (req as WorkspaceAwareRequest).workspace?.workspaceId ?? null;

    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required to delete an agent" });
      return;
    }

    try {
      const deleted = await deleteAgentConfig(id, workspaceId);
      if (!deleted) {
        res.status(404).json({ error: `Agent "${id}" not found` });
        return;
      }
      res.json({ message: `Agent "${id}" deleted` });
    } catch (err) {
      console.error("[agents] Delete error:", err);
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  // GET /agents/:id/versions — list all config versions
  router.get("/:id/versions", async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }
    try {
      const versions = await listAgentVersions(id, workspaceId);
      res.json({ versions });
    } catch (err) {
      console.error("[agents] List versions:", err);
      res.status(500).json({ error: "Failed to list versions" });
    }
  });

  // GET /agents/:id/versions/:version — get specific config version
  router.get("/:id/versions/:version", async (req: Request, res: Response) => {
    const { id, version } = req.params as { id: string; version: string };
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }
    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      res.status(400).json({ error: "Invalid version number" });
      return;
    }
    try {
      const config = await getAgentVersion(id, workspaceId, versionNum);
      if (!config) {
        res.status(404).json({ error: `Version ${versionNum} not found` });
        return;
      }
      res.json({ version: versionNum, config });
    } catch (err) {
      console.error("[agents] Get version:", err);
      res.status(500).json({ error: "Failed to get version" });
    }
  });

  // POST /agents/:id/versions/:version/rollback — restore agent to a historical version
  router.post("/:id/versions/:version/rollback", async (req: Request, res: Response) => {
    const { uid } = req as AuthenticatedRequest;
    const { id, version } = req.params as { id: string; version: string };
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }
    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      res.status(400).json({ error: "Invalid version number" });
      return;
    }
    try {
      const historicalConfig = await getAgentVersion(id, workspaceId, versionNum);
      if (!historicalConfig) {
        res.status(404).json({ error: `Version ${versionNum} not found` });
        return;
      }
      const updated = await updateAgentConfig(id, {
        displayName: historicalConfig.displayName,
        tier: historicalConfig.tier,
        model: historicalConfig.model,
        systemPromptTemplate: historicalConfig.systemPromptTemplate,
        tools: historicalConfig.tools,
        skills: historicalConfig.skills,
        session: historicalConfig.session,
        spawn: historicalConfig.spawn,
      }, uid, workspaceId);
      if (!updated) {
        res.status(404).json({ error: `Agent "${id}" not found` });
        return;
      }
      const versions = await listAgentVersions(id, workspaceId);
      const newVersion = versions[0];
      if (newVersion) {
        await updateVersionLabel(id, workspaceId, newVersion.version, `rollback-from-v${versionNum}`);
      }
      res.json({ agent: updated, rolledBackFrom: versionNum, newVersion: newVersion?.version ?? null });
    } catch (err) {
      console.error("[agents] Rollback:", err);
      res.status(500).json({ error: "Failed to rollback" });
    }
  });

  // GET /agents/:id/versions/:v1/diff/:v2 — diff two versions
  router.get("/:id/versions/:v1/diff/:v2", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) { res.status(400).json({ error: "Workspace required" }); return; }

    const { id, v1, v2 } = req.params as { id: string; v1: string; v2: string };
    const v1Num = parseInt(v1, 10);
    const v2Num = parseInt(v2, 10);
    if (isNaN(v1Num) || isNaN(v2Num) || v1Num < 1 || v2Num < 1) {
      res.status(400).json({ error: "Invalid version numbers" });
      return;
    }
    try {
      const { getPool } = await import("../../config/postgres.js");
      const pool = getPool();
      const result = await pool.query(
        `SELECT version, config FROM agent_version_snapshots WHERE agent_id = $1 AND workspace_id = $2 AND version = ANY($3)`,
        [id, workspaceId, [v1Num, v2Num]],
      );
      if (result.rows.length < 2) { res.status(404).json({ error: "One or both versions not found" }); return; }
      const rowA = result.rows.find((r: { version: number; config: Record<string, unknown> }) => r.version === v1Num);
      const rowB = result.rows.find((r: { version: number; config: Record<string, unknown> }) => r.version === v2Num);
      if (!rowA || !rowB) { res.status(404).json({ error: "Version not found" }); return; }
      const diff = diffAgentVersions(rowA.config as Record<string, unknown>, rowB.config as Record<string, unknown>);
      res.json({ diff, v1: v1Num, v2: v2Num });
    } catch (err) {
      console.error("[agents] diff:", err);
      res.status(500).json({ error: "Failed to diff versions" });
    }
  });

  // PATCH /agents/:id/versions/:version — update a version's label
  router.patch("/:id/versions/:version", async (req: Request, res: Response) => {
    const { id, version } = req.params as { id: string; version: string };
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }
    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      res.status(400).json({ error: "Invalid version number" });
      return;
    }
    const parsed = PatchVersionLabelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }
    try {
      const ok = await updateVersionLabel(id, workspaceId, versionNum, parsed.data.label);
      if (!ok) {
        res.status(404).json({ error: `Version ${versionNum} not found` });
        return;
      }
      res.json({ message: `Version ${versionNum} label updated` });
    } catch (err) {
      console.error("[agents] Patch version:", err);
      res.status(500).json({ error: "Failed to update label" });
    }
  });

  return router;
}
