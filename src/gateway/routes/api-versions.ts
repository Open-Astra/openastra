import { Router } from "express";
import { z } from "zod";
import { getPool } from "../../config/postgres.js";

const CreateBody = z.object({
  version: z.string(),
  changelog: z.string().optional(),
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

  router.post("/api-versions", async (req, res) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const pool = getPool();
    await pool.query(
      `INSERT INTO api_versions (version, changelog) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parsed.data.version, parsed.data.changelog ?? null],
    );
    res.status(201).json({ version: parsed.data.version });
  });

  router.put("/api-versions/:version/deprecate", async (req, res) => {
    const sunsetAt = req.body.sunsetAt ? new Date(req.body.sunsetAt) : null;
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
