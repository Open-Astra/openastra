import { Router } from "express";
import { getQueueStats } from "../middleware/priority-queue.js";

export function createQueueStatusRouter(): Router {
  const router = Router();

  router.get("/queue/status", (_req, res) => {
    res.json(getQueueStats());
  });

  return router;
}
