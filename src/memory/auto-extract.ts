import type { InferenceClient } from "../inference/types.js";
import { getPool } from "../config/postgres.js";
import { findOrCreateEntity, createEdge, updateEntityConfidence, type EntityType, type EdgeType } from "./graph.js";
import { createLogger } from "../utils/logger.js";

// ── Auto Knowledge-Graph Extraction + Reinforcement ─────────────────
// Automatically extracts entities and relationships from conversations
// and documents, builds the knowledge graph, and reinforces connections
// over time based on access patterns and user feedback.
//
// Extraction pipeline:
//   1. LLM extracts entities + relationships from text
//   2. Fuzzy-match against existing entities (dedup)
//   3. Create/reinforce entities and edges
//   4. Score entities by importance
//   5. Periodic reinforcement decay on stale nodes

const log = createLogger("auto-extract");

// ── Types ───────────────────────────────────────────────────────────

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  memories: Array<{ category: string; content: string }>;
  confidence: number;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
  properties: Record<string, unknown>;
}

export interface ExtractedRelationship {
  source: string;  // entity name
  target: string;  // entity name
  type: EdgeType;
  confidence: number;
  evidence: string;
}

export interface ReinforcementConfig {
  decayFactor: number;          // daily decay multiplier (default: 0.97)
  accessReinforcement: number;  // score boost per access (default: 0.1)
  feedbackReinforcement: number; // score boost per positive feedback (default: 0.2)
  minScore: number;             // prune below this (default: 0.01)
}

const DEFAULT_REINFORCEMENT: ReinforcementConfig = {
  decayFactor: 0.97,
  accessReinforcement: 0.1,
  feedbackReinforcement: 0.2,
  minScore: 0.01,
};

// ── Extract from Text ───────────────────────────────────────────────

/**
 * Extract entities and relationships from a text using LLM.
 */
export async function extractFromText(
  text: string,
  _uid: string,
  inferenceClient: InferenceClient,
  context?: string,
): Promise<ExtractionResult> {
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `Extract entities and relationships from the text below.

Entity types: person, team, event, concept, market, outcome, document
Relationship types: plays_for, related_to, caused_by, contradicts, supports, part_of, preceded_by, correlated_with, mentioned_in, user_noted

Respond in JSON:
{
  "entities": [
    {"name": "...", "type": "person|team|...", "description": "...", "properties": {}}
  ],
  "relationships": [
    {"source": "entity_name", "target": "entity_name", "type": "related_to|...", "confidence": 0.0-1.0, "evidence": "..."}
  ]
}

Rules:
- Only extract clearly stated facts, not speculation
- Use proper names (capitalize)
- Keep descriptions concise (1 sentence)
- Confidence: 0.9+ for explicit statements, 0.5-0.8 for inferred

Also extract memorable facts as a "memories" array:
"memories": [
  {"category": "decision|outcome|strategy|note|interaction", "content": "concise fact to remember"}
]`,
      },
      {
        role: "user",
        content: context
          ? `Context: ${context}\n\nText to extract from:\n${text.slice(0, 3000)}`
          : text.slice(0, 3000),
      },
    ],
    temperature: 0.1,
    maxTokens: 1500,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { entities: [], relationships: [], memories: [], confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ExtractionResult>;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      memories: Array.isArray((parsed as { memories?: unknown[] }).memories) ? (parsed as { memories?: Array<{ category: string; content: string }> }).memories! : [],
      confidence: parsed.confidence ?? 0.7,
    };
  } catch {
    return { entities: [], relationships: [], memories: [], confidence: 0 };
  }
}

/**
 * Extract and persist entities/relationships to the knowledge graph.
 */
export async function extractAndPersist(
  text: string,
  uid: string,
  inferenceClient: InferenceClient,
  context?: string,
): Promise<{ entitiesCreated: number; edgesCreated: number; memoriesCreated: number }> {
  const result = await extractFromText(text, uid, inferenceClient, context);

  let entitiesCreated = 0;
  let edgesCreated = 0;

  // Entity name → ID mapping
  const entityMap = new Map<string, string>();

  // Create/find entities
  for (const entity of result.entities) {
    try {
      const graphEntity = await findOrCreateEntity(
        uid,
        entity.type,
        entity.name,
        entity.description,
        entity.properties,
      );
      entityMap.set(entity.name.toLowerCase(), graphEntity.id);
      entitiesCreated++;

      // Confidence decay on description conflict
      if (graphEntity.description && entity.description &&
          graphEntity.description.length > 10 &&
          entity.description.length > 10 &&
          !entity.description.toLowerCase().includes(graphEntity.description.slice(0, 20).toLowerCase())) {
        // Descriptions differ — slight confidence decay
        updateEntityConfidence(graphEntity.id, -0.05).catch(() => {});
      }
    } catch (err) {
      log.dim(`Failed to create entity "${entity.name}": ${err}`);
    }
  }

  // Create edges
  for (const rel of result.relationships) {
    const sourceId = entityMap.get(rel.source.toLowerCase());
    const targetId = entityMap.get(rel.target.toLowerCase());

    if (!sourceId || !targetId) continue;

    try {
      await createEdge(uid, sourceId, targetId, rel.type, rel.confidence, {
        evidence: rel.evidence,
        extractedAt: Date.now(),
      });
      edgesCreated++;
    } catch (err) {
      log.dim(`Failed to create edge ${rel.source} → ${rel.target}: ${err}`);
    }
  }

  // Persist extracted memories to daily memory
  if (result.memories.length > 0) {
    const { appendDailyMemory } = await import("./store.js");
    const validCategories = ["decision", "outcome", "strategy", "note", "interaction"];
    for (const mem of result.memories) {
      const category = validCategories.includes(mem.category) ? mem.category as "decision" | "outcome" | "strategy" | "note" | "interaction" : "note";
      await appendDailyMemory(uid, {
        timestamp: Date.now(),
        category,
        content: mem.content,
      }).catch((err: unknown) => log.dim(`Failed to write extracted memory: ${err}`));
    }
  }

  if (entitiesCreated > 0 || edgesCreated > 0 || result.memories.length > 0) {
    log.info(`Extracted ${entitiesCreated} entities, ${edgesCreated} edges, ${result.memories.length} memories from ${text.length} chars`);
  }

  return { entitiesCreated, edgesCreated, memoriesCreated: result.memories.length };
}

// ── Batch Extraction ────────────────────────────────────────────────

/**
 * Extract from multiple texts (e.g., session messages) in batch.
 */
export async function batchExtract(
  texts: Array<{ text: string; context?: string }>,
  uid: string,
  inferenceClient: InferenceClient,
): Promise<{ totalEntities: number; totalEdges: number; totalMemories: number }> {
  let totalEntities = 0;
  let totalEdges = 0;
  let totalMemories = 0;

  for (const { text, context } of texts) {
    if (text.length < 50) continue; // skip trivial messages

    try {
      const result = await extractAndPersist(text, uid, inferenceClient, context);
      totalEntities += result.entitiesCreated;
      totalEdges += result.edgesCreated;
      totalMemories += result.memoriesCreated;
    } catch (err) {
      log.dim(`Batch extraction failed for text chunk: ${err}`);
    }
  }

  return { totalEntities, totalEdges, totalMemories };
}

// ── Reinforcement ───────────────────────────────────────────────────

/**
 * Reinforce an entity when it's accessed/mentioned.
 */
export async function reinforceEntity(
  entityId: string,
  boost: number = DEFAULT_REINFORCEMENT.accessReinforcement,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE graph_entities
     SET reinforcement_score = LEAST(1.0, reinforcement_score + $1),
         access_count = access_count + 1,
         last_accessed_at = NOW()
     WHERE id = $2`,
    [boost, entityId],
  );
}

/**
 * Reinforce an edge when its relationship is confirmed.
 */
export async function reinforceEdge(
  edgeId: string,
  boost: number = DEFAULT_REINFORCEMENT.accessReinforcement,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE graph_edges
     SET weight = LEAST(1.0, weight + $1),
         reinforcement_count = reinforcement_count + 1,
         last_reinforced_at = NOW()
     WHERE id = $2`,
    [boost, edgeId],
  );
}

/**
 * Apply user feedback to entities mentioned in a conversation.
 */
export async function applyFeedback(
  uid: string,
  entityNames: string[],
  positive: boolean,
): Promise<void> {
  const pool = getPool();
  const boost = positive
    ? DEFAULT_REINFORCEMENT.feedbackReinforcement
    : -DEFAULT_REINFORCEMENT.feedbackReinforcement;

  for (const name of entityNames) {
    await pool.query(
      `UPDATE graph_entities
       SET reinforcement_score = GREATEST(0.01, LEAST(1.0, reinforcement_score + $1))
       WHERE uid = $2 AND LOWER(name) = LOWER($3)`,
      [boost, uid, name],
    );
  }
}

/**
 * Run daily reinforcement decay on all entities and edges.
 */
export async function runReinforcementDecay(
  config: Partial<ReinforcementConfig> = {},
): Promise<{ entitiesDecayed: number; edgesDecayed: number; entitiesPruned: number }> {
  const opts = { ...DEFAULT_REINFORCEMENT, ...config };
  const pool = getPool();

  // Decay entities
  const entityResult = await pool.query(
    `UPDATE graph_entities
     SET reinforcement_score = reinforcement_score * $1
     WHERE last_accessed_at < NOW() - INTERVAL '1 day'
       AND reinforcement_score > $2`,
    [opts.decayFactor, opts.minScore],
  );

  // Decay edges
  const edgeResult = await pool.query(
    `UPDATE graph_edges
     SET weight = GREATEST($2, weight * $1)
     WHERE last_reinforced_at < NOW() - INTERVAL '1 day'
       AND weight > $2`,
    [opts.decayFactor, opts.minScore],
  );

  // Prune entities below threshold with no edges
  const pruneResult = await pool.query(
    `DELETE FROM graph_entities
     WHERE reinforcement_score < $1
       AND id NOT IN (SELECT source_id FROM graph_edges UNION SELECT target_id FROM graph_edges)`,
    [opts.minScore],
  );

  const result = {
    entitiesDecayed: entityResult.rowCount ?? 0,
    edgesDecayed: edgeResult.rowCount ?? 0,
    entitiesPruned: pruneResult.rowCount ?? 0,
  };

  if (result.entitiesDecayed > 0 || result.entitiesPruned > 0) {
    log.info(`Reinforcement decay: ${result.entitiesDecayed} entities, ${result.edgesDecayed} edges, ${result.entitiesPruned} pruned`);
  }

  return result;
}
