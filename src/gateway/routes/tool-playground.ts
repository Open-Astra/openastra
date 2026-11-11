import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { platformAdmin } from "../middleware/platform-admin.js";
import { getMemberRole } from "../../workspaces/store.js";
import { getTool, getRegisteredToolNames, executeTool } from "../../tools/registry.js";
import type { ToolContext } from "../../tools/types.js";
import { createLogger } from "../../utils/logger.js";
import { HOST_ACCESS_TOOLS, normalizeToolId } from "../middleware/host-tools.js";

// ── Tool Playground ─────────────────────────────────────────────────
// Invokes a registered tool directly, with no agent in the loop. That is
// arbitrary code execution on the gateway host for any tool that touches
// the shell, filesystem or database, so the route is:
//
//   • OFF unless TOOL_PLAYGROUND_ENABLED=true
//   • platform-admin only (INTERNAL_API_KEY in X-Api-Key, on top of JWT)
//   • restricted to an allowlist: TOOL_PLAYGROUND_TOOLS (comma-separated).
//     With no list, every tool EXCEPT the host-access set below is allowed;
//     those must be named explicitly to be callable here.
//   • executed through executeTool() so tool policy, RBAC, rate limits and
//     auditing apply exactly as they do for an agent.
//
// Nothing on this path fails open: any missing configuration is a refusal.

const log = createLogger("tool-playground");

const norm = normalizeToolId;

function configuredAllowlist(): Set<string> | null {
  const raw = process.env.TOOL_PLAYGROUND_TOOLS;
  if (!raw) return null;
  const names = raw.split(",").map(norm).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

function isToolPermitted(toolName: string): boolean {
  const allow = configuredAllowlist();
  const n = norm(toolName);
  if (allow) return allow.has(n);
  return !HOST_ACCESS_TOOLS.has(n) && n !== "agent_spawn";
}

function playgroundEnabled() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (process.env.TOOL_PLAYGROUND_ENABLED !== "true") {
      // 404 — do not advertise a disabled debugging surface
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };
}

export function createToolPlaygroundRouter(): Router {
  const router = Router();
  const gate = [playgroundEnabled(), platformAdmin()];

  // GET /playground/tools — list the tools callable through the playground
  router.get("/playground/tools", ...gate, (_req, res) => {
    res.json({ tools: getRegisteredToolNames().filter(isToolPermitted) });
  });

  // POST /playground/tool/:toolName — invoke a tool directly without an agent
  router.post("/playground/tool/:toolName", ...gate, async (req, res) => {
    const { toolName } = req.params as { toolName: string };

    if (!isToolPermitted(toolName)) {
      res.status(403).json({ error: `Tool "${toolName}" is not enabled for the playground` });
      return;
    }

    const tool = getTool(toolName);
    if (!tool) {
      res.status(404).json({ error: `Tool not found: ${toolName}` });
      return;
    }

    const parsed = tool.parameters.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues });
      return;
    }

    const uid = (req as unknown as AuthenticatedRequest).uid;

    // Optional workspace scope — the caller must really be a member.
    const rawWs = req.headers["x-workspace-id"];
    const workspaceId = Array.isArray(rawWs) ? rawWs[0] : rawWs;
    if (workspaceId) {
      try {
        const role = await getMemberRole(workspaceId, uid);
        if (!role || role === "viewer") {
          res.status(403).json({ error: "Not permitted to run tools in this workspace" });
          return;
        }
      } catch {
        res.status(503).json({ error: "Workspace membership check failed" });
        return;
      }
    }

    const ctx: ToolContext = {
      uid,
      sessionId: randomUUID(),
      agentId: "playground",
      workspaceId: workspaceId || undefined,
    };

    log.warn(`uid=${uid} invoked tool "${toolName}" via playground`);

    const start = Date.now();
    try {
      // executeTool enforces policy/RBAC/limits; the allow set is exactly
      // the one tool that passed the playground allowlist above.
      const result = await executeTool(
        { id: randomUUID(), name: toolName, arguments: JSON.stringify(parsed.data) },
        ctx,
        new Set([toolName]),
      );
      if (result.error) {
        res.status(422).json({ toolName, error: result.error, durationMs: Date.now() - start });
        return;
      }
      res.json({ toolName, result, durationMs: Date.now() - start });
    } catch (err) {
      log.error(`Tool "${toolName}" failed:`, err);
      res.status(500).json({ error: "Tool execution failed", durationMs: Date.now() - start });
    }
  });

  return router;
}
