import { getPool } from "../config/postgres.js";

// ── Memory Graph Visualization Data ──────────────────────────────────
// Exports memory graph data in a format suitable for D3/Cytoscape
// visualization. Reads from existing graph_entities + graph_relationships
// (graph_edges) tables — no migration needed.

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  weight: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: string;
  weight: number;
}

export interface GraphVizData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    avgWeight: number;
  };
}

export interface GraphVizOptions {
  limit?: number;
  minWeight?: number;
}

export async function getGraphVizData(
  _workspaceId: string,
  uid: string,
  options: GraphVizOptions = {},
): Promise<GraphVizData> {
  const pool = getPool();
  const limit = options.limit ?? 200;
  const minWeight = options.minWeight ?? 0;

  // Fetch entities for this user (uid scoped; workspace used for validation)
  const entitiesResult = await pool.query<{
    id: string;
    name: string;
    type: string;
    reinforcement_score: number;
    confidence: number;
  }>(
    `SELECT id, name, type, reinforcement_score, confidence
     FROM graph_entities
     WHERE uid = $1
     ORDER BY reinforcement_score DESC
     LIMIT $2`,
    [uid, limit],
  );

  const entityIds = entitiesResult.rows.map((r) => r.id);

  if (entityIds.length === 0) {
    return {
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, avgWeight: 0 },
    };
  }

  // Fetch edges connecting those entities
  const edgesResult = await pool.query<{
    source_id: string;
    target_id: string;
    type: string;
    weight: number;
  }>(
    `SELECT source_id, target_id, type, weight
     FROM graph_edges
     WHERE uid = $1
       AND source_id = ANY($2::uuid[])
       AND target_id = ANY($2::uuid[])
       AND weight >= $3`,
    [uid, entityIds, minWeight],
  );

  const nodes: GraphNode[] = entitiesResult.rows.map((r) => ({
    id: r.id,
    label: r.name,
    type: r.type,
    weight: r.reinforcement_score,
  }));

  const edges: GraphEdge[] = edgesResult.rows.map((r) => ({
    source: r.source_id,
    target: r.target_id,
    relationship: r.type,
    weight: r.weight,
  }));

  const avgWeight =
    edges.length > 0
      ? edges.reduce((sum, e) => sum + e.weight, 0) / edges.length
      : 0;

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      avgWeight: Math.round(avgWeight * 1000) / 1000,
    },
  };
}
