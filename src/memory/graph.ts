import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { getGraphEdgeCache, setGraphEdgeCache } from "./graph-cache.js";

// ── Graph Memory Core ───────────────────────────────────────────────
// Every fact becomes a node (entity) connected by typed edges with
// temporal decay and reinforcement. Supports multi-hop traversal
// via recursive CTEs and semantic search via pgvector.
//
// PostgreSQL tables: graph_entities, graph_edges
// (see src/data/migrations/001-graph-schema.sql)

// ── Types ───────────────────────────────────────────────────────────

export type EntityType =
  | "person"    // player, coach, analyst
  | "team"
  | "event"     // game, match
  | "concept"   // strategy, pattern, rule
  | "market"    // prop type, line
  | "outcome"   // bet result
  | "document"; // external reference

export type EdgeType =
  | "plays_for"        // person → team
  | "related_to"       // generic association
  | "caused_by"        // outcome → event
  | "contradicts"      // concept ↔ concept
  | "supports"         // concept → concept
  | "part_of"          // entity → group
  | "preceded_by"      // temporal ordering
  | "correlated_with"  // statistical relationship
  | "mentioned_in"     // entity → document
  | "user_noted";      // user-created connection

export interface GraphEntity {
  id: string;
  uid: string;
  type: EntityType;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  confidence: number;          // 0-1 fact confidence, starts at 1.0
  // Temporal
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  // Decay: score diminishes over time, reinforced on access
  reinforcementScore: number;
}

export interface GraphEdge {
  id: string;
  uid: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number; // 0-1 confidence
  metadata: Record<string, unknown>;
  // Temporal
  createdAt: number;
  lastReinforcedAt: number;
  reinforcementCount: number;
}

export interface GraphSearchResult {
  entity: GraphEntity;
  score: number;
  connectedEntities?: Array<{
    entity: GraphEntity;
    edge: GraphEdge;
    score: number;
  }>;
}

// ── Row Mappers ─────────────────────────────────────────────────────
// SQL snake_case → TypeScript camelCase

interface EntityRow {
  id: string;
  uid: string;
  type: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  confidence: number;
  reinforcement_score: number;
  access_count: number;
  created_at: string | Date;
  last_accessed_at: string | Date;
}

interface EdgeRow {
  id: string;
  uid: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string | Date;
  last_reinforced_at: string | Date;
  reinforcement_count: number;
}

function rowToEntity(row: EntityRow): GraphEntity {
  return {
    id: row.id,
    uid: row.uid,
    type: row.type as EntityType,
    name: row.name,
    description: row.description ?? "",
    properties: row.properties ?? {},
    confidence: Number(row.confidence ?? 1.0),
    createdAt: new Date(row.created_at).getTime(),
    lastAccessedAt: new Date(row.last_accessed_at).getTime(),
    accessCount: row.access_count,
    reinforcementScore: row.reinforcement_score,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    uid: row.uid,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as EdgeType,
    weight: row.weight,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).getTime(),
    lastReinforcedAt: new Date(row.last_reinforced_at).getTime(),
    reinforcementCount: row.reinforcement_count,
  };
}

/** Format a number[] embedding as a pgvector literal */
function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ── CRUD: Entities ──────────────────────────────────────────────────

export async function createEntity(
  uid: string,
  type: EntityType,
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): Promise<GraphEntity> {
  const pool = getPool();

  // Generate embedding for semantic search (best-effort)
  let embeddingStr: string | null = null;
  try {
    const vec = await generateEmbedding(`${name}: ${description}`);
    embeddingStr = toVector(vec);
  } catch {
    // Embeddings unavailable — entity still stored without vector
  }

  const result = await pool.query<EntityRow>(
    `INSERT INTO graph_entities (uid, type, name, description, properties, embedding)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)
     RETURNING *`,
    [uid, type, name, description, JSON.stringify(properties), embeddingStr],
  );

  return rowToEntity(result.rows[0]!);
}

export async function getEntity(uid: string, entityId: string): Promise<GraphEntity | null> {
  const pool = getPool();

  const result = await pool.query<EntityRow>(
    `SELECT * FROM graph_entities WHERE id = $1::uuid AND uid = $2`,
    [entityId, uid],
  );

  if (result.rowCount === 0) return null;

  // Reinforce on access (fire-and-forget)
  pool.query(
    `UPDATE graph_entities
     SET last_accessed_at = NOW(),
         access_count = access_count + 1,
         reinforcement_score = reinforcement_score + 0.1
     WHERE id = $1::uuid AND uid = $2`,
    [entityId, uid],
  ).catch(() => {});

  return rowToEntity(result.rows[0]!);
}

export async function findEntitiesByName(
  uid: string,
  name: string,
  type?: EntityType,
): Promise<GraphEntity[]> {
  const pool = getPool();
  const params: unknown[] = [uid, name];
  let sql = `SELECT * FROM graph_entities WHERE uid = $1 AND name = $2`;

  if (type) {
    sql += ` AND type = $3`;
    params.push(type);
  }
  sql += ` LIMIT 10`;

  const result = await pool.query<EntityRow>(sql, params);
  return result.rows.map(rowToEntity);
}

export async function findOrCreateEntity(
  uid: string,
  type: EntityType,
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): Promise<GraphEntity> {
  const existing = await findEntitiesByName(uid, name, type);

  if (existing.length > 0) {
    const entity = existing[0]!;
    const pool = getPool();

    await pool.query(
      `UPDATE graph_entities
       SET last_accessed_at = NOW(),
           access_count = access_count + 1,
           reinforcement_score = reinforcement_score + 0.2,
           description = CASE WHEN $3 = '' THEN description ELSE $3 END
       WHERE id = $1::uuid AND uid = $2`,
      [entity.id, uid, description],
    );

    return { ...entity, lastAccessedAt: Date.now() };
  }

  return createEntity(uid, type, name, description, properties);
}

// ── CRUD: Edges ─────────────────────────────────────────────────────

export async function createEdge(
  uid: string,
  sourceId: string,
  targetId: string,
  type: EdgeType,
  weight: number = 0.5,
  metadata: Record<string, unknown> = {},
): Promise<GraphEdge> {
  const pool = getPool();

  // Upsert: create new edge or reinforce existing (UNIQUE constraint on uid+source+target+type)
  const result = await pool.query<EdgeRow>(
    `INSERT INTO graph_edges (uid, source_id, target_id, type, weight, metadata)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::jsonb)
     ON CONFLICT (uid, source_id, target_id, type) DO UPDATE SET
       weight = LEAST(1.0, graph_edges.weight + 0.1),
       last_reinforced_at = NOW(),
       reinforcement_count = graph_edges.reinforcement_count + 1
     RETURNING *`,
    [uid, sourceId, targetId, type, weight, JSON.stringify(metadata)],
  );

  return rowToEdge(result.rows[0]!);
}

export async function getEdgesFrom(
  uid: string,
  entityId: string,
  edgeType?: EdgeType,
): Promise<GraphEdge[]> {
  const pool = getPool();
  const params: unknown[] = [uid, entityId];
  let sql = `SELECT * FROM graph_edges WHERE uid = $1 AND source_id = $2::uuid`;

  if (edgeType) {
    sql += ` AND type = $3`;
    params.push(edgeType);
  }
  sql += ` LIMIT 50`;

  const result = await pool.query<EdgeRow>(sql, params);
  return result.rows.map(rowToEdge);
}

export async function getEdgesTo(
  uid: string,
  entityId: string,
  edgeType?: EdgeType,
): Promise<GraphEdge[]> {
  const pool = getPool();
  const params: unknown[] = [uid, entityId];
  let sql = `SELECT * FROM graph_edges WHERE uid = $1 AND target_id = $2::uuid`;

  if (edgeType) {
    sql += ` AND type = $3`;
    params.push(edgeType);
  }
  sql += ` LIMIT 50`;

  const result = await pool.query<EdgeRow>(sql, params);
  return result.rows.map(rowToEdge);
}

export async function updateEntityConfidence(
  entityId: string,
  delta: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE graph_entities
     SET confidence = GREATEST(0.0, LEAST(1.0, confidence + $1))
     WHERE id = $2`,
    [delta, entityId],
  );
}

// ── Multi-Hop Traversal ─────────────────────────────────────────────
// Recursive CTE runs the entire multi-hop graph walk in a single query.
// Cycle detection via a visited[] path array prevents infinite loops.
// Temporal decay (7-day half-life) and edge weight are applied server-side.

export async function traverse(
  uid: string,
  startEntityId: string,
  maxHops: number = 2,
  maxResults: number = 20,
): Promise<GraphSearchResult[]> {
  const pool = getPool();

  const result = await pool.query<EntityRow & { score: string; hop: number }>(
    `WITH RECURSIVE graph_walk AS (
       -- Base: start entity
       SELECT
         e.id,
         0 AS hop,
         e.reinforcement_score::double precision AS score,
         ARRAY[e.id] AS visited
       FROM graph_entities e
       WHERE e.id = $1::uuid AND e.uid = $2

       UNION ALL

       -- Recursive: walk edges (both directions), apply decay + weight
       SELECT
         next_e.id,
         gw.hop + 1,
         gw.score
           * edge.weight
           * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - next_e.last_accessed_at)) / 604800.0)
           * next_e.reinforcement_score
           * CASE WHEN edge.source_id = gw.id THEN 1.0 ELSE 0.8 END,
         gw.visited || next_e.id
       FROM graph_walk gw
       JOIN graph_edges edge
         ON edge.uid = $2
         AND (edge.source_id = gw.id OR edge.target_id = gw.id)
       JOIN graph_entities next_e
         ON next_e.uid = $2
         AND next_e.id = CASE
           WHEN edge.source_id = gw.id THEN edge.target_id
           ELSE edge.source_id
         END
       WHERE gw.hop < $3
         AND NOT (next_e.id = ANY(gw.visited))
     )
     SELECT
       sub.score, sub.hop,
       e.id, e.uid, e.type, e.name, e.description, e.properties,
       e.confidence, e.reinforcement_score, e.access_count,
       e.created_at, e.last_accessed_at
     FROM (
       SELECT DISTINCT ON (id) id, score, hop
       FROM graph_walk
       WHERE hop > 0
       ORDER BY id, score DESC
     ) sub
     JOIN graph_entities e ON e.id = sub.id
     ORDER BY sub.score DESC
     LIMIT $4`,
    [startEntityId, uid, maxHops, maxResults],
  );

  return result.rows.map((row) => ({
    entity: rowToEntity(row),
    score: parseFloat(row.score),
  }));
}

// ── Graph-Enhanced Search ───────────────────────────────────────────
// pgvector cosine similarity finds seed entities, then 1-hop expansion
// fetches their graph neighborhood — all in PostgreSQL.

export async function graphSearch(
  uid: string,
  query: string,
  topK: number = 5,
): Promise<GraphSearchResult[]> {
  // ── Graph edge LRU cache check ─────────────────────────────────
  const cacheHit = getGraphEdgeCache(uid, query, "search");
  if (cacheHit) {
    // Reconstruct minimal GraphSearchResult[] from the cache entry.
    // The cache stores entity names and relation strings; for a cache hit
    // we return lightweight stubs so callers get the content without a DB round-trip.
    return cacheHit.entities.map((name, i) => ({
      entity: {
        id: "",
        uid,
        type: "concept" as EntityType,
        name,
        description: cacheHit.relations[i] ?? "",
        properties: {},
        confidence: cacheHit.score,
        createdAt: cacheHit.cachedAt,
        lastAccessedAt: cacheHit.cachedAt,
        accessCount: 0,
        reinforcementScore: cacheHit.score,
      },
      score: cacheHit.score,
    }));
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch {
    return []; // Embeddings unavailable
  }

  const pool = getPool();
  const vecStr = toVector(queryEmbedding);

  // Phase 1: Seed entities via pgvector cosine distance
  const seedResult = await pool.query<EntityRow & { similarity: string }>(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM graph_entities
     WHERE uid = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vecStr, uid, topK],
  );

  if (seedResult.rowCount === 0) return [];

  const graphResults: GraphSearchResult[] = [];

  // Phase 2: 1-hop expansion for each seed entity
  for (const row of seedResult.rows) {
    const entity = rowToEntity(row);

    const expansionResult = await pool.query<
      EntityRow & {
        edge_id: string;
        edge_uid: string;
        source_id: string;
        target_id: string;
        edge_type: string;
        edge_weight: number;
        edge_metadata: Record<string, unknown>;
        edge_created_at: string | Date;
        last_reinforced_at: string | Date;
        reinforcement_count: number;
      }
    >(
      `SELECT
         e.id, e.uid, e.type, e.name, e.description, e.properties,
         e.confidence, e.reinforcement_score, e.access_count,
         e.created_at, e.last_accessed_at,
         edge.id AS edge_id, edge.uid AS edge_uid,
         edge.source_id, edge.target_id,
         edge.type AS edge_type, edge.weight AS edge_weight,
         edge.metadata AS edge_metadata, edge.created_at AS edge_created_at,
         edge.last_reinforced_at, edge.reinforcement_count
       FROM graph_edges edge
       JOIN graph_entities e
         ON e.id = CASE
           WHEN edge.source_id = $1::uuid THEN edge.target_id
           ELSE edge.source_id
         END
         AND e.uid = $2
       WHERE edge.uid = $2
         AND (edge.source_id = $1::uuid OR edge.target_id = $1::uuid)
       LIMIT 5`,
      [entity.id, uid],
    );

    const connectedEntities: NonNullable<GraphSearchResult["connectedEntities"]> =
      expansionResult.rows.map((r) => ({
        entity: rowToEntity(r),
        edge: {
          id: r.edge_id,
          uid: r.edge_uid,
          sourceId: r.source_id,
          targetId: r.target_id,
          type: r.edge_type as EdgeType,
          weight: r.edge_weight,
          metadata: r.edge_metadata ?? {},
          createdAt: new Date(r.edge_created_at).getTime(),
          lastReinforcedAt: new Date(r.last_reinforced_at).getTime(),
          reinforcementCount: r.reinforcement_count,
        },
        score: r.edge_weight * r.reinforcement_score,
      }));

    graphResults.push({
      entity,
      score: parseFloat(row.similarity),
      connectedEntities: connectedEntities.length > 0 ? connectedEntities : undefined,
    });
  }

  // ── Graph edge LRU cache write ─────────────────────────────────
  if (graphResults.length > 0) {
    const avgScore =
      graphResults.reduce((sum, r) => sum + r.score, 0) / graphResults.length;
    setGraphEdgeCache(uid, query, "search", {
      entities: graphResults.map((r) => r.entity.name),
      relations: graphResults.map((r) => r.entity.description),
      score: avgScore,
      cachedAt: Date.now(),
    });
  }

  return graphResults;
}

// ── Schema Migration ────────────────────────────────────────────────
// Runs the graph schema SQL if not already applied.

export async function ensureGraphSchema(): Promise<void> {
  const pool = getPool();

  // Check if migration already applied
  try {
    const result = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = 'graph-001'`,
    );
    if (result.rowCount && result.rowCount > 0) {
      if (!process.env.ASTRA_STANDALONE) console.log("[graph] Schema already up to date (v1)");
      return;
    }
  } catch {
    // Table doesn't exist yet — migration hasn't run
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationPath = join(currentDir, "..", "data", "migrations", "001-graph-schema.sql");
  const sql = await readFile(migrationPath, "utf-8");
  await pool.query(sql);
  if (!process.env.ASTRA_STANDALONE) console.log("[graph] Applied migration: 001-graph-schema");
}

// ── Extract Entities from Text ──────────────────────────────────────
// Lightweight entity extraction for auto-populating the graph from
// agent conversations. Returns potential entity mentions.

export function extractEntityMentions(text: string): Array<{ name: string; type: EntityType }> {
  const mentions: Array<{ name: string; type: EntityType }> = [];

  // NBA/NFL/MLB player name pattern (First Last or First Last Jr./III)
  const playerPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}(?:\s+(?:Jr\.|Sr\.|III|II|IV))?)\b/g;
  let match;
  while ((match = playerPattern.exec(text)) !== null) {
    // Filter common false positives
    const name = match[1]!;
    if (name.length > 4 && !COMMON_WORDS.has(name)) {
      mentions.push({ name, type: "person" });
    }
  }

  // Team names (known NBA/NFL/MLB/NHL teams)
  for (const team of KNOWN_TEAMS) {
    if (text.toLowerCase().includes(team.toLowerCase())) {
      mentions.push({ name: team, type: "team" });
    }
  }

  return mentions;
}

const COMMON_WORDS = new Set([
  "The Over", "The Under", "Draft Kings", "Fan Duel",
  "Good Morning", "Thank You", "How Much", "Last Night",
]);

const KNOWN_TEAMS = [
  // NBA
  "Lakers", "Celtics", "Warriors", "Bucks", "76ers", "Nuggets", "Heat",
  "Suns", "Mavericks", "Clippers", "Knicks", "Nets", "Bulls", "Cavaliers",
  "Timberwolves", "Thunder", "Kings", "Pelicans", "Hawks", "Raptors",
  "Pacers", "Magic", "Grizzlies", "Rockets", "Spurs", "Trail Blazers",
  "Jazz", "Pistons", "Hornets", "Wizards",
  // NFL
  "Chiefs", "Eagles", "49ers", "Cowboys", "Bills", "Ravens", "Dolphins",
  "Lions", "Bengals", "Jaguars", "Texans", "Browns", "Chargers", "Packers",
  "Steelers", "Jets", "Bears", "Vikings", "Raiders", "Seahawks", "Commanders",
  "Saints", "Falcons", "Buccaneers", "Panthers", "Cardinals", "Rams",
  "Broncos", "Colts", "Titans", "Giants", "Patriots",
];
