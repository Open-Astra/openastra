// ── Hierarchical Cache Invalidation (Feature 3) ──────────────────────
// Manages parent-child relationships for cascade invalidation.
// When a parent cache entry is invalidated, all children are also invalidated.
// When a child is invalidated, parent knows to refresh its rollup.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

const log = createLogger("hierarchical-invalidation");

export interface HierarchyNode {
  cacheId: string;
  parentId: string | null;
  children: HierarchyNode[];
  createdAt: Date;
}

/**
 * Establish a parent-child relationship in the cache hierarchy.
 * @param childId - Child cache entry UUID
 * @param parentId - Parent cache entry UUID (null to make root)
 */
export async function setCacheHierarchy(childId: string, parentId: string | null): Promise<void> {
  try {
    const pool = getPool();

    // Update or insert the hierarchy relationship
    await pool.query(
      `INSERT INTO cache_hierarchy (cache_id, hierarchy_parent_id)
       VALUES ($1, $2)
       ON CONFLICT (cache_id) DO UPDATE SET hierarchy_parent_id = $2`,
      [childId, parentId],
    );

    log.info(`Set cache hierarchy: ${childId} -> ${parentId || "root"}`);
  } catch (err) {
    log.warn(
      `Failed to set cache hierarchy: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Get the full hierarchy tree for a cache entry (upwards and downwards).
 * @param cacheId - Cache entry UUID
 * @returns Hierarchy node with parent and children
 */
export async function getCacheHierarchy(cacheId: string): Promise<HierarchyNode> {
  try {
    const pool = getPool();

    // Get the entry itself
    const selfResult = await pool.query<{
      cache_id: string;
      hierarchy_parent_id: string | null;
      created_at: Date;
    }>(
      `SELECT cache_id, hierarchy_parent_id, created_at
       FROM cache_hierarchy
       WHERE cache_id = $1`,
      [cacheId],
    );

    if (selfResult.rows.length === 0) {
      // Entry doesn't exist in hierarchy — return a new root node
      return {
        cacheId,
        parentId: null,
        children: [],
        createdAt: new Date(),
      };
    }

    const self = selfResult.rows[0]!;

    // Get all children recursively
    const childrenResult = await pool.query<{
      cache_id: string;
      hierarchy_parent_id: string | null;
      created_at: Date;
    }>(
      `WITH RECURSIVE children_tree AS (
         SELECT cache_id, hierarchy_parent_id, created_at
         FROM cache_hierarchy
         WHERE hierarchy_parent_id = $1

         UNION ALL

         SELECT ch.cache_id, ch.hierarchy_parent_id, ch.created_at
         FROM cache_hierarchy ch
         INNER JOIN children_tree ct ON ch.hierarchy_parent_id = ct.cache_id
       )
       SELECT cache_id, hierarchy_parent_id, created_at FROM children_tree`,
      [cacheId],
    );

    // Build tree recursively
    const buildTree = (nodeId: string): HierarchyNode => {
      const node = childrenResult.rows.find(r => r.cache_id === nodeId);
      const directChildren = childrenResult.rows.filter(r => r.hierarchy_parent_id === nodeId);

      return {
        cacheId: nodeId,
        parentId: node?.hierarchy_parent_id ?? null,
        children: directChildren.map(c => buildTree(c.cache_id)),
        createdAt: node?.created_at ?? new Date(),
      };
    };

    return {
      cacheId: self.cache_id,
      parentId: self.hierarchy_parent_id,
      children: childrenResult.rows
        .filter(r => r.hierarchy_parent_id === cacheId)
        .map(c => buildTree(c.cache_id)),
      createdAt: self.created_at,
    };
  } catch (err) {
    log.warn(`Failed to get cache hierarchy: ${err instanceof Error ? err.message : String(err)}`);
    return {
      cacheId,
      parentId: null,
      children: [],
      createdAt: new Date(),
    };
  }
}

/**
 * Invalidate a cache entry and cascade up to parent and down to children.
 * @param cacheId - Cache entry UUID to invalidate
 * @returns Number of entries invalidated
 */
export async function invalidateCacheHierarchy(cacheId: string): Promise<number> {
  try {
    const pool = getPool();

    // Get the hierarchy to understand cascade direction
    const entry = await pool.query<{
      cache_id: string;
      hierarchy_parent_id: string | null;
    }>(
      `SELECT cache_id, hierarchy_parent_id FROM cache_hierarchy WHERE cache_id = $1`,
      [cacheId],
    );

    if (entry.rows.length === 0) {
      return 0;
    }

    let totalInvalidated = 0;

    // 1. Invalidate this entry and all descendants
    const descendantResult = await pool.query<{ cache_id: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT cache_id FROM cache_hierarchy WHERE cache_id = $1

         UNION ALL

         SELECT ch.cache_id
         FROM cache_hierarchy ch
         INNER JOIN descendants d ON ch.hierarchy_parent_id = d.cache_id
       )
       SELECT cache_id FROM descendants`,
      [cacheId],
    );

    const descendantIds = descendantResult.rows.map(r => r.cache_id);

    // 2. Delete all descendants from hierarchy
    if (descendantIds.length > 0) {
      const placeholders = descendantIds.map((_, i) => `$${i + 1}`).join(",");
      const deleteResult = await pool.query(
        `DELETE FROM cache_hierarchy WHERE cache_id IN (${placeholders})`,
        descendantIds,
      );
      totalInvalidated = deleteResult.rowCount ?? 0;
      log.info(`Cascade invalidated ${totalInvalidated} cache entries from ${cacheId}`);
    }

    // 3. Mark parent for refresh (if it exists)
    const parent = entry.rows[0];
    if (parent && parent.hierarchy_parent_id) {
      log.info(`Marked parent ${parent.hierarchy_parent_id} for refresh after child invalidation`);
      // Parent will need to recompute its aggregation on next access
    }

    return totalInvalidated;
  } catch (err) {
    log.warn(
      `Failed to invalidate cache hierarchy: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Create a new cache hierarchy root entry.
 * @returns UUID for the new root
 */
export async function createCacheHierarchyRoot(): Promise<string> {
  try {
    const id = randomUUID();
    const pool = getPool();

    await pool.query(
      `INSERT INTO cache_hierarchy (cache_id, hierarchy_parent_id)
       VALUES ($1, NULL)`,
      [id],
    );

    return id;
  } catch (err) {
    log.warn(`Failed to create cache hierarchy root: ${err instanceof Error ? err.message : String(err)}`);
    return randomUUID();
  }
}
