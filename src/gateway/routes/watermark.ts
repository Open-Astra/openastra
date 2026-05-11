import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { detectWatermark } from "../../security/watermark.js";

const DetectBody = z.object({
  text: z.string(),
});

export function createWatermarkRouter(): Router {
  const router = Router();

  // POST /security/watermark/detect — detect workspace watermark in text
  router.post("/detect", async (req: Request, res: Response) => {
    const parsed = DetectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const workspaceId = detectWatermark(parsed.data.text);
    res.json({ workspaceId });
  });

  return router;
}
