import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentConfig } from "../../agents/types.js";
import type { InferenceClient } from "../../inference/types.js";
import { getAgentConfig } from "../../config/agents.js";
import { runAutonomousAgent } from "../../agents/autonomous.js";

// ── Request Validation ──────────────────────────────────────────────

const AutonomousRunBody = z.object({
  uid: z.string().min(1),
  agentId: z.string().min(1),
  taskMessage: z.string().min(1),
});

const BatchRunBody = z.object({
  uids: z.array(z.string().min(1)).min(1),
  agentId: z.string().min(1),
  taskMessage: z.string().min(1),
});

// ── Internal API Key Auth ──────────────────────────────────────────

function internalApiKey() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.INTERNAL_API_KEY;
    const expectedPrev = process.env.INTERNAL_API_KEY_PREV;

    if (!expected) {
      console.error("[autonomous] INTERNAL_API_KEY not configured");
      res.status(500).json({ error: "Server misconfigured — internal API key not set" });
      return;
    }

    const provided = req.headers["x-api-key"];

    if (typeof provided !== "string") {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    // Try current key first
    const matchesCurrent =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    // Try previous key for zero-downtime rotation
    const matchesPrev =
      !matchesCurrent &&
      expectedPrev &&
      provided.length === expectedPrev.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expectedPrev));

    if (!matchesCurrent && !matchesPrev) {
      res.status(401).json({ error: "Invalid or missing API key" });
      return;
    }

    next();
  };
}

// ── Autonomous Router Factory ──────────────────────────────────────

export function createAutonomousRouter(resolveClient: (config: AgentConfig) => InferenceClient): Router {
  const router = Router();

  // All autonomous routes require internal API key auth
  router.use(internalApiKey());

  // POST /autonomous/run — Run any agent autonomously for a user
  router.post("/run", async (req: Request, res: Response) => {
    const parsed = AutonomousRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { uid, agentId, taskMessage } = parsed.data;

    try {
      const agentConfig = getAgentConfig(agentId);
      const response = await runAutonomousAgent(
        uid,
        agentConfig,
        taskMessage,
        resolveClient(agentConfig),
      );

      res.json({
        uid,
        agentId,
        success: true,
        sessionId: response.sessionId,
        usage: response.tokenUsage,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[autonomous] Agent ${agentId} failed for uid=${uid}:`, err);
      res.status(500).json({ uid, agentId, success: false, error: message });
    }
  });

  // POST /autonomous/batch — Run an agent for multiple users
  router.post("/batch", async (req: Request, res: Response) => {
    const parsed = BatchRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const { uids, agentId, taskMessage } = parsed.data;

    let agentConfig: AgentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      res.status(404).json({ error: `Unknown agent: ${agentId}` });
      return;
    }

    const results = await Promise.allSettled(
      uids.map(async (uid) => {
        const response = await runAutonomousAgent(
          uid,
          agentConfig,
          taskMessage,
          resolveClient(agentConfig),
        );
        return { uid, success: true, sessionId: response.sessionId };
      }),
    );

    const formatted = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { uid: uids[i], success: false, error: r.reason?.message ?? String(r.reason) },
    );

    const allSucceeded = formatted.every((r) => r.success);
    res.status(allSucceeded ? 200 : 207).json({ results: formatted });
  });

  return router;
}
