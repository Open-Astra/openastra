import { z } from "zod";
import { registerTool } from "./registry.js";
import {
  getEntity,
  findEntitiesByName,
  getEdgesFrom,
  getEdgesTo,
  traverse,
  graphSearch,
} from "../memory/graph.js";
import type { EntityType, EdgeType } from "../memory/graph.js";

// ── graph_query Tool ────────────────────────────────────────────────
// Allows agents to directly explore the knowledge graph — find entities,
// walk edges, do multi-hop traversals, and semantic graph search.

const GraphQueryParams = z.object({
  operation: z
    .enum(["find_entity", "get_entity", "edges_from", "edges_to", "traverse", "search"])
    .describe(
      "Operation: find_entity (by name), get_entity (by ID), edges_from/edges_to (direct connections), traverse (multi-hop walk), search (semantic)",
    ),
  // For find_entity
  name: z.string().optional().describe("Entity name to search for (find_entity)"),
  entityType: z
    .enum(["person", "team", "event", "concept", "market", "outcome", "document"])
    .optional()
    .describe("Filter by entity type"),
  // For get_entity, edges_from, edges_to, traverse
  entityId: z.string().optional().describe("Entity UUID (get_entity, edges_from/to, traverse)"),
  // For edges_from/to
  edgeType: z
    .enum([
      "plays_for", "related_to", "caused_by", "contradicts", "supports",
      "part_of", "preceded_by", "correlated_with", "mentioned_in", "user_noted",
    ])
    .optional()
    .describe("Filter edges by type"),
  // For traverse
  maxHops: z.number().int().min(1).max(4).default(2).describe("Max hops for traversal (default 2)"),
  maxResults: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
  // For search
  query: z.string().optional().describe("Semantic search query (search operation)"),
});

registerTool({
  name: "graph_query",
  description:
    "Query the knowledge graph to explore entities, relationships, and connections. Supports: find_entity (by name), get_entity (by ID), edges_from/edges_to (direct connections), traverse (multi-hop walk with temporal decay), search (semantic pgvector search with 1-hop expansion).",
  parameters: GraphQueryParams,
  async execute(params, ctx) {
    switch (params.operation) {
      case "find_entity": {
        if (!params.name) return { error: "name is required for find_entity" };
        const entities = await findEntitiesByName(
          ctx.uid,
          params.name,
          params.entityType as EntityType | undefined,
        );
        return {
          count: entities.length,
          entities: entities.map(formatEntity),
        };
      }

      case "get_entity": {
        if (!params.entityId) return { error: "entityId is required for get_entity" };
        const entity = await getEntity(ctx.uid, params.entityId);
        if (!entity) return { error: `Entity not found: ${params.entityId}` };
        return { entity: formatEntity(entity) };
      }

      case "edges_from": {
        if (!params.entityId) return { error: "entityId is required for edges_from" };
        const edges = await getEdgesFrom(
          ctx.uid,
          params.entityId,
          params.edgeType as EdgeType | undefined,
        );
        return {
          count: edges.length,
          edges: edges.map((e) => ({
            id: e.id,
            type: e.type,
            targetId: e.targetId,
            weight: Math.round(e.weight * 100) / 100,
            reinforcements: e.reinforcementCount,
          })),
        };
      }

      case "edges_to": {
        if (!params.entityId) return { error: "entityId is required for edges_to" };
        const edges = await getEdgesTo(
          ctx.uid,
          params.entityId,
          params.edgeType as EdgeType | undefined,
        );
        return {
          count: edges.length,
          edges: edges.map((e) => ({
            id: e.id,
            type: e.type,
            sourceId: e.sourceId,
            weight: Math.round(e.weight * 100) / 100,
            reinforcements: e.reinforcementCount,
          })),
        };
      }

      case "traverse": {
        if (!params.entityId) return { error: "entityId is required for traverse" };
        const results = await traverse(
          ctx.uid,
          params.entityId,
          params.maxHops,
          params.maxResults,
        );
        return {
          startEntity: params.entityId,
          maxHops: params.maxHops,
          count: results.length,
          results: results.map((r) => ({
            entity: formatEntity(r.entity),
            score: Math.round(r.score * 1000) / 1000,
            connected: r.connectedEntities?.map((c) => ({
              entity: formatEntity(c.entity),
              edgeType: c.edge.type,
              score: Math.round(c.score * 1000) / 1000,
            })),
          })),
        };
      }

      case "search": {
        if (!params.query) return { error: "query is required for search" };
        const results = await graphSearch(ctx.uid, params.query, params.maxResults);
        return {
          query: params.query,
          count: results.length,
          results: results.map((r) => ({
            entity: formatEntity(r.entity),
            similarity: Math.round(r.score * 1000) / 1000,
            connected: r.connectedEntities?.map((c) => ({
              name: c.entity.name,
              type: c.entity.type,
              edgeType: c.edge.type,
              weight: Math.round(c.edge.weight * 100) / 100,
            })),
          })),
        };
      }

      default:
        return { error: `Unknown operation: ${params.operation}` };
    }
  },
});

function formatEntity(e: { id: string; type: string; name: string; description: string; properties: Record<string, unknown>; accessCount: number; reinforcementScore: number }) {
  return {
    id: e.id,
    type: e.type,
    name: e.name,
    description: e.description,
    properties: Object.keys(e.properties).length > 0 ? e.properties : undefined,
    accessCount: e.accessCount,
    reinforcement: Math.round(e.reinforcementScore * 100) / 100,
  };
}
