import { Router } from "express";
import { z } from "zod";
import {
  setEphemeral,
  getEphemeral,
  getAllEphemeral,
  deleteEphemeral,
  clearEphemeral,
} from "../../memory/ephemeral.js";

const SetBody = z.object({
  value: z.unknown(),
  ttlSeconds: z.number().int().positive().optional(),
});

export function createEphemeralMemoryRouter(): Router {
  const router = Router();

  router.get("/sessions/:sessionId/ephemeral", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const all = await getAllEphemeral(sessionId);
    res.json({ data: all });
  });

  router.put("/sessions/:sessionId/ephemeral/:key", async (req, res) => {
    const body = SetBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: body.error.issues }); return; }
    const { sessionId, key } = req.params as { sessionId: string; key: string };
    await setEphemeral(sessionId, key, body.data.value, body.data.ttlSeconds);
    res.json({ set: true });
  });

  router.get("/sessions/:sessionId/ephemeral/:key", async (req, res) => {
    const { sessionId, key } = req.params as { sessionId: string; key: string };
    const value = await getEphemeral(sessionId, key);
    if (value === null) { res.status(404).json({ error: "Key not found or expired" }); return; }
    res.json({ key, value });
  });

  router.delete("/sessions/:sessionId/ephemeral/:key", async (req, res) => {
    const { sessionId, key } = req.params as { sessionId: string; key: string };
    await deleteEphemeral(sessionId, key);
    res.json({ deleted: true });
  });

  router.delete("/sessions/:sessionId/ephemeral", async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const count = await clearEphemeral(sessionId);
    res.json({ cleared: count });
  });

  return router;
}
