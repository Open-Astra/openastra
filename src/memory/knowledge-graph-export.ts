// ── Knowledge Graph Export ───────────────────────────────────────────
// Export the entity relationship graph in GraphML, JSON-LD, or Cypher format.

import { getPool } from "../config/postgres.js";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
}

async function fetchGraph(
  userId: string,
  workspaceId: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const pool = getPool();

  // Attempt to read from graph_entities / graph_edges — table names may differ
  // so we try the most common name and fall back gracefully.
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];

  try {
    const { rows: nodeRows } = await pool.query<{
      id: string;
      label: string;
      entity_type: string;
      properties: Record<string, unknown>;
    }>(
      `SELECT id, label, entity_type, properties
       FROM graph_entities
       WHERE uid = $1 AND workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    );
    nodes = nodeRows.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.entity_type,
      properties: r.properties ?? {},
    }));
  } catch {
    // Table may not exist yet
  }

  try {
    const { rows: edgeRows } = await pool.query<{
      id: string;
      source_id: string;
      target_id: string;
      relation: string;
      weight: number;
    }>(
      `SELECT ge.id, ge.source_id, ge.target_id, ge.relation,
              COALESCE(ge.reinforcement_score, 1.0) AS weight
       FROM graph_edges ge
       JOIN graph_entities src ON src.id = ge.source_id
       WHERE src.uid = $1 AND src.workspace_id IS NOT DISTINCT FROM $2`,
      [userId, workspaceId],
    );
    edges = edgeRows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      relation: r.relation,
      weight: r.weight,
    }));
  } catch {
    // Table may not exist yet
  }

  return { nodes, edges };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function exportAsGraphML(userId: string, workspaceId: string): Promise<string> {
  const { nodes, edges } = await fetchGraph(userId, workspaceId);

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<graphml xmlns="http://graphml.graphdrawing.org/graphml">`,
    `  <key id="label" for="node" attr.name="label" attr.type="string"/>`,
    `  <key id="type"  for="node" attr.name="type"  attr.type="string"/>`,
    `  <key id="rel"   for="edge" attr.name="relation" attr.type="string"/>`,
    `  <key id="wt"    for="edge" attr.name="weight"   attr.type="double"/>`,
    `  <graph id="G" edgedefault="directed">`,
  ];

  for (const n of nodes) {
    lines.push(`    <node id="${escapeXml(n.id)}">`);
    lines.push(`      <data key="label">${escapeXml(n.label)}</data>`);
    lines.push(`      <data key="type">${escapeXml(n.type)}</data>`);
    lines.push(`    </node>`);
  }

  for (const e of edges) {
    lines.push(`    <edge id="${escapeXml(e.id)}" source="${escapeXml(e.sourceId)}" target="${escapeXml(e.targetId)}">`);
    lines.push(`      <data key="rel">${escapeXml(e.relation)}</data>`);
    lines.push(`      <data key="wt">${e.weight}</data>`);
    lines.push(`    </edge>`);
  }

  lines.push(`  </graph>`, `</graphml>`);
  return lines.join("\n");
}

export async function exportAsJsonLd(userId: string, workspaceId: string): Promise<object> {
  const { nodes, edges } = await fetchGraph(userId, workspaceId);

  const graph = nodes.map((n) => ({
    "@id": `urn:astra:entity:${n.id}`,
    "@type": n.type,
    name: n.label,
    ...n.properties,
  }));

  for (const e of edges) {
    const sourceNode = graph.find((n) => (n as Record<string, unknown>)["@id"] === `urn:astra:entity:${e.sourceId}`);
    if (sourceNode) {
      (sourceNode as Record<string, unknown>)[e.relation] = { "@id": `urn:astra:entity:${e.targetId}` };
    }
  }

  return {
    "@context": { "@vocab": "https://schema.org/" },
    "@graph": graph,
  };
}

export async function exportAsCypher(userId: string, workspaceId: string): Promise<string> {
  const { nodes, edges } = await fetchGraph(userId, workspaceId);

  const lines: string[] = ["// Astra Knowledge Graph — Cypher CREATE statements"];

  for (const n of nodes) {
    const propsStr = Object.entries({ label: n.label, ...n.properties })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`CREATE (:${n.type} {id: "${n.id}", ${propsStr}});`);
  }

  for (const e of edges) {
    const rel = e.relation.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
    lines.push(`MATCH (a {id: "${e.sourceId}"}), (b {id: "${e.targetId}"}) CREATE (a)-[:${rel} {weight: ${e.weight}}]->(b);`);
  }

  return lines.join("\n");
}
