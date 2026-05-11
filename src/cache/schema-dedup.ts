// ── Schema-Aware Query Deduplication (Feature 6) ───────────────────────
// Normalizes queries by their structure, stripping values to find semantic groups.
// Enables bulk invalidation of similar queries.

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";

const log = createLogger("schema-dedup");

/**
 * Normalize a query by removing literal values and comments.
 * Works with SQL and GraphQL.
 * @param queryText - Original query text
 * @returns Normalized query (structure only, no values)
 */
export async function normalizeQuerySchema(queryText: string): Promise<string> {
  try {
    let normalized = queryText.trim();

    // Detect query type
    const isSql = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/i.test(normalized);
    const isGraphql = /^\s*(\{|query|mutation|subscription)\s*/i.test(normalized);

    if (isSql) {
      // SQL normalization: parameterize values in WHERE/VALUES clauses
      // Remove string literals: 'value' -> ?
      normalized = normalized.replace(/'[^']*'/g, "?");
      // Remove numeric literals in WHERE: = 123 -> = ?
      normalized = normalized.replace(/=\s*\d+(?!\w)/g, "= ?");
      // Remove comments
      normalized = normalized.replace(/--.*$/gm, "");
      normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
    } else if (isGraphql) {
      // GraphQL normalization: remove alias names, normalize field order
      // Remove aliases: field: alias -> field
      normalized = normalized.replace(/(\w+)\s*:\s*(\w+)/g, "$2");
      // Remove literal values in arguments: (arg: "value") -> (arg: $VAR)
      normalized = normalized.replace(/:\s*"[^"]*"/g, ': $VAR');
      normalized = normalized.replace(/:\s*\d+/g, ": $VAR");
      // Remove newlines for consistent spacing
      normalized = normalized.replace(/\s+/g, " ");
    }

    // Lowercase for case-insensitive comparison
    normalized = normalized.toLowerCase().trim();

    return normalized;
  } catch (err) {
    log.warn(`Query normalization failed: ${err instanceof Error ? err.message : String(err)}`);
    return queryText.toLowerCase();
  }
}

/**
 * Get a deduplication key for a query.
 * Creates or retrieves the schema hash from the database.
 * @param queryText - Original query text
 * @returns Schema hash for deduplication
 */
export async function getDedupKey(queryText: string): Promise<string> {
  try {
    const pool = getPool();

    // Normalize the query to get its structure
    const normalized = await normalizeQuerySchema(queryText);
    const schemaHash = createHash("sha256").update(normalized).digest("hex");

    // Check if schema already exists
    const existing = await pool.query<{ schema_hash: string }>(
      `SELECT schema_hash FROM query_schemas WHERE schema_hash = $1`,
      [schemaHash],
    );

    if (existing.rows.length > 0) {
      return schemaHash;
    }

    // New schema — insert it
    const semtanticGroup = randomUUID();
    const queryType = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/i.test(queryText)
      ? "sql"
      : /^\s*(\{|query|mutation|subscription)\s*/i.test(queryText)
        ? "graphql"
        : "other";

    await pool.query(
      `INSERT INTO query_schemas (schema_hash, semantic_group, query_example, normalized_query, query_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (schema_hash) DO NOTHING`,
      [schemaHash, semtanticGroup, queryText, normalized, queryType],
    );

    return schemaHash;
  } catch (err) {
    log.warn(`Failed to get dedup key: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: use direct hash of query
    return createHash("sha256").update(queryText).digest("hex");
  }
}

/**
 * Find the semantic group for a query.
 * Returns UUID of the group, enabling bulk invalidation.
 * @param queryText - Original query text
 * @returns Semantic group UUID or null
 */
export async function findSemanticGroup(queryText: string): Promise<string | null> {
  try {
    const pool = getPool();

    const dedupKey = await getDedupKey(queryText);

    const result = await pool.query<{ semantic_group: string }>(
      `SELECT semantic_group FROM query_schemas WHERE schema_hash = $1`,
      [dedupKey],
    );

    if (result.rows.length > 0) {
      return result.rows[0]!.semantic_group;
    }

    return null;
  } catch (err) {
    log.warn(
      `Failed to find semantic group: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Bulk invalidate all queries in a semantic group.
 * @param semanticGroupId - UUID of the semantic group
 * @returns Number of schemas affected
 */
export async function invalidateSemanticGroup(semanticGroupId: string): Promise<number> {
  try {
    const pool = getPool();

    const result = await pool.query(
      `DELETE FROM query_schemas WHERE semantic_group = $1`,
      [semanticGroupId],
    );

    const count = result.rowCount ?? 0;
    log.info(`Invalidated ${count} schemas in semantic group ${semanticGroupId}`);

    return count;
  } catch (err) {
    log.warn(
      `Failed to invalidate semantic group: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Get all queries in a semantic group.
 * Useful for diagnostics and understanding query patterns.
 * @param semanticGroupId - UUID of the semantic group
 * @returns List of query examples
 */
export async function getSemanticGroupQueries(semanticGroupId: string): Promise<string[]> {
  try {
    const pool = getPool();

    const result = await pool.query<{ query_example: string }>(
      `SELECT query_example FROM query_schemas WHERE semantic_group = $1`,
      [semanticGroupId],
    );

    return result.rows.map(row => row.query_example);
  } catch (err) {
    log.warn(
      `Failed to get semantic group queries: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
