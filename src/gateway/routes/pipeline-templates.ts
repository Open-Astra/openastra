import { Router } from "express";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { loadPipelineTemplates, executePipeline, type PipelineTemplate } from "../../agents/pipeline-templates.js";
import { getInferenceClientForAgent } from "../../inference/factory.js";
import { getAgentConfig } from "../../config/agents.js";
import type { InferenceClient } from "../../inference/types.js";

const ExecutePipelineBody = z.object({
  templateId: z.string().min(1),
  input: z.string().min(1).max(100_000),
});

// Default pipeline templates path
const DEFAULT_TEMPLATES_PATH = resolve(process.cwd(), "pipeline-templates.yml");

// Cached templates
let cachedTemplates: PipelineTemplate[] | null = null;

async function getTemplates(): Promise<PipelineTemplate[]> {
  if (cachedTemplates) return cachedTemplates;

  if (existsSync(DEFAULT_TEMPLATES_PATH)) {
    try {
      cachedTemplates = await loadPipelineTemplates(DEFAULT_TEMPLATES_PATH);
    } catch {
      cachedTemplates = [];
    }
  } else {
    cachedTemplates = [];
  }

  return cachedTemplates;
}

export function createPipelineTemplatesRouter(): Router {
  const router = Router();

  // GET /pipeline-templates — list available templates
  router.get("/pipeline-templates", async (_req, res) => {
    const templates = await getTemplates();
    res.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        stepCount: t.steps.length,
      })),
    });
  });

  // POST /pipeline-templates/execute — execute a template
  router.post("/pipeline-templates/execute", async (req, res) => {
    const parsed = ExecutePipelineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;
    const templates = await getTemplates();
    const template = templates.find((t) => t.id === parsed.data.templateId);

    if (!template) {
      res.status(404).json({ error: `Template "${parsed.data.templateId}" not found` });
      return;
    }

    try {
      // Build inference clients for all agents in the pipeline
      const clients = new Map<string, InferenceClient>();
      for (const step of template.steps) {
        if (!clients.has(step.agentId)) {
          try {
            const config = getAgentConfig(step.agentId);
            const client = getInferenceClientForAgent(config);
            clients.set(step.agentId, client);
          } catch (err) {
            res.status(404).json({
              error: `Agent "${step.agentId}" in step "${step.id}" not found: ${err instanceof Error ? err.message : String(err)}`,
            });
            return;
          }
        }
      }

      const results = await executePipeline(template, parsed.data.input, uid, clients);

      // Convert Map to object for JSON serialization
      const resultObj: Record<string, string> = {};
      for (const [k, v] of results) {
        resultObj[k] = v;
      }

      res.json({ templateId: template.id, results: resultObj });
    } catch (err) {
      console.error("[pipeline-templates] Execute:", err);
      res.status(500).json({ error: "Failed to execute pipeline" });
    }
  });

  return router;
}
