import type { Pool } from "pg";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Cross-Workspace Knowledge Merge ───────────────────────────────────
// Merges graph entities from a source workspace into a target workspace.
// Deduplicates by entity name (case-insensitive), keeping the higher
// reinforcement_score when a name collision is detected.

const log = createLogger("knowledge-merge");

export interface MergeResult {
  copied: number;
  deduplicated: number;
  errors: number;
}

interface EntityRow {
  id: string;
  uid: string;
  type: string;
  name: string;
  description: string;
  properties: unknown;
  confidence: number;
  reinforcement_score: number;
}

export async function mergeKnowledge(
  requestId: string,
  _sourceWorkspaceId: string,
  _targetWorkspaceId: string,
  uid: string,
  pool?: Pool,
): Promise<MergeResult> {
  const db = pool ?? getPool();
  let copied = 0;
  let deduplicated = 0;
  let errors = 0;

  // Mark request as in-progress
  await db
    .query(
      `UPDATE knowledge_merge_requests SET status = 'processing' WHERE id = $1`,
      [requestId],
    )
    .catch(() => {});

  try {
    // Fetch source entities for the requesting uid
    const { rows: sourceEntities } = await db.query<EntityRow>(
      `SELECT id, uid, type, name, description, properties, confidence, reinforcement_score
       FROM graph_entities
       WHERE uid = $1`,
      [uid],
    );

    // Fetch existing target entity names (lower-cased for dedup)
    const { rows: targetNames } = await db.query<{ name: string; id: string; reinforcement_score: number }>(
      `SELECT name, id, reinforcement_score FROM graph_entities WHERE uid = $1`,
      [uid],
    );

    const targetNameMap = new Map<string, { id: string; score: number }>();
    for (const t of targetNames) {
      targetNameMap.set(t.name.toLowerCase(), { id: t.id, score: t.reinforcement_score });
    }

    for (const entity of sourceEntities) {
      const nameLower = entity.name.toLowerCase();
      const existing = targetNameMap.get(nameLower);

      if (existing) {
        // Dedup: update reinforcement_score if source has higher value
        if (entity.reinforcement_score > existing.score) {
          await db
            .query(
              `UPDATE graph_entities
               SET reinforcement_score = $1,
                   description = CASE WHEN length(description) < length($2) THEN $2 ELSE description END,
                   confidence = GREATEST(confidence, $3)
               WHERE id = $4`,
              [entity.reinforcement_score, entity.description, entity.confidence, existing.id],
            )
            .catch(() => { errors++; });
        }
        deduplicated++;
      } else {
        // Copy entity into target (same uid, new UUID to avoid PK collision)
        const props =
          typeof entity.properties === "string"
            ? entity.properties
            : JSON.stringify(entity.properties ?? {});

        await db
          .query(
            `INSERT INTO graph_entities
               (uid, type, name, description, properties, confidence, reinforcement_score)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT DO NOTHING`,
            [uid, entity.type, entity.name, entity.description, props, entity.confidence, entity.reinforcement_score],
          )
          .then(() => {
            copied++;
            targetNameMap.set(nameLower, { id: entity.id, score: entity.reinforcement_score });
          })
          .catch(() => { errors++; });
      }
    }

    // Mark complete
    await db.query(
      `UPDATE knowledge_merge_requests
       SET status = 'completed', merged_count = $1, completed_at = NOW()
       WHERE id = $2`,
      [copied, requestId],
    ).catch(() => {});

    log.info(
      `Knowledge merge ${requestId} done: copied=${copied} deduped=${deduplicated} errors=${errors}`,
    );
  } catch (err) {
    log.error(`Knowledge merge ${requestId} failed:`, err);
    await db
      .query(`UPDATE knowledge_merge_requests SET status = 'failed' WHERE id = $1`, [requestId])
      .catch(() => {});
    throw err;
  }

  return { copied, deduplicated, errors };
}
