import { Router } from "express";
import {
  queryByTimeRange,
  getMemoryTimeline,
  getEntityTimeline,
} from "../../memory/temporal.js";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../../gateway/middleware/workspace.js";

export function createMemoryTemporalRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const opts: Record<string, unknown> = {};

      if (req.query["uid"] !== undefined) opts["uid"] = String(req.query["uid"]);
      if (req.query["category"] !== undefined) opts["category"] = String(req.query["category"]);
      if (req.query["from"] !== undefined) opts["from"] = new Date(String(req.query["from"]));
      if (req.query["to"] !== undefined) opts["to"] = new Date(String(req.query["to"]));
      if (req.query["limit"] !== undefined) opts["limit"] = Number(req.query["limit"]);
      if (req.query["order"] !== undefined) opts["order"] = String(req.query["order"]);

      const records = await queryByTimeRange(workspaceId, opts);
      return res.json(records);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/timeline", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const uid = req.query["uid"];
      if (!uid) return res.status(400).json({ error: "uid is required" });

      const bucketParse = z.enum(["day", "week", "month"]).safeParse(req.query["bucket"] ?? "day");
      const bucket = bucketParse.success ? bucketParse.data : "day" as const;
      const timeline = await getMemoryTimeline(workspaceId, String(uid), bucket);
      return res.json(timeline);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  router.get("/entities/:name/timeline", async (req, res) => {
    try {
      const { workspaceId } = (req as unknown as WorkspaceAwareRequest).workspace;
      if (!workspaceId) return res.status(400).json({ error: "workspace required" });

      const { name } = req.params;
      const entityBucketParse = z.enum(["day", "week"]).safeParse(req.query["bucket"] ?? "day");
      const bucket = entityBucketParse.success ? entityBucketParse.data : "day" as const;
      const timeline = await getEntityTimeline(workspaceId, name, bucket);
      return res.json(timeline);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
