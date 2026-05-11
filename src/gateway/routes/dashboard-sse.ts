import { Router } from "express";
import { createDashboardSseHandler } from "../../observability/dashboard-sse.js";

// ── Dashboard SSE Router ─────────────────────────────────────────────
// GET /dashboard/stream — SSE endpoint for real-time agent activity

export function createDashboardSseRouter(): Router {
  const router = Router();

  // GET /dashboard/stream — SSE stream of agent activity events
  router.get("/stream", createDashboardSseHandler());

  return router;
}
