import { Router } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";
import { platformAdmin } from "../middleware/platform-admin.js";

const CreateBody = z.object({
  version: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/),
  changelog: z.string().max(10_000).optional(),
});

const DeprecateBody = z.object({
  sunsetAt: z.coerce.date().optional(),
});

export function createApiVersionsRouter(): Router {
  const router = Router();

  router.get("/api-versions", async (_req, res) => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT version, status, released_at AS "releasedAt", deprecated_at AS "deprecatedAt",
              sunset_at AS "sunsetAt", changelog, created_at AS "createdAt"
       FROM api_versions ORDER BY released_at DESC`,
    );
    res.json({ versions: rows });
  });

  router.get("/api-versions/:version", async (req, res) => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT version, status, released_at AS "releasedAt", deprecated_at AS "deprecatedAt",
              sunset_at AS "sunsetAt", changelog
       FROM api_versions WHERE version = $1`,
      [req.params.version],
    );
    if (rows.length === 0) return res.status(404).json({ error: "Version not found" });
    res.json(rows[0]);
  });

  // API version lifecycle is platform-global — operator only
  router.post("/api-versions", platformAdmin(), async (req, res) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const pool = getPool();
    await pool.query(
      `INSERT INTO api_versions (version, changelog) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parsed.data.version, parsed.data.changelog ?? null],
    );
    res.status(201).json({ version: parsed.data.version });
  });

  router.put("/api-versions/:version/deprecate", platformAdmin(), async (req, res) => {
    const body = DeprecateBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.message });
    const sunsetAt = body.data.sunsetAt ?? null;
    const pool = getPool();
    const { rowCount } = await pool.query(
      `UPDATE api_versions SET status = 'deprecated', deprecated_at = now(), sunset_at = $2
       WHERE version = $1`,
      [req.params.version, sunsetAt],
    );
    if (!rowCount) return res.status(404).json({ error: "Version not found" });
    res.json({ deprecated: true });
  });

  return router;
}
