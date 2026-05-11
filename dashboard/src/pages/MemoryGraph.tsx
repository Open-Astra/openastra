import { useState, useRef, useEffect, useCallback } from "react";
import { Brain, ZoomIn, ZoomOut, Maximize2, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

interface GraphNode {
  id: string;
  label: string;
  type: "entity" | "concept" | "person" | "project" | "skill";
  tier: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weight: number;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
  strength: number;
}

const NODE_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  entity: { fill: "#0ea5e9", stroke: "#38bdf8", text: "#e0f2fe" },
  concept: { fill: "#8b5cf6", stroke: "#a78bfa", text: "#ede9fe" },
  person: { fill: "#10b981", stroke: "#34d399", text: "#d1fae5" },
  project: { fill: "#f59e0b", stroke: "#fbbf24", text: "#fef3c7" },
  skill: { fill: "#ec4899", stroke: "#f472b6", text: "#fce7f3" },
};

function createMockGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rawNodes = [
    { id: "openastra", label: "OpenAstra", type: "project" as const, tier: "long-term", weight: 1.0 },
    { id: "nodejs", label: "Node.js", type: "skill" as const, tier: "long-term", weight: 0.8 },
    { id: "typescript", label: "TypeScript", type: "skill" as const, tier: "long-term", weight: 0.9 },
    { id: "python", label: "Python", type: "skill" as const, tier: "long-term", weight: 0.85 },
    { id: "rust", label: "Rust", type: "skill" as const, tier: "long-term", weight: 0.7 },
    { id: "user", label: "User", type: "person" as const, tier: "long-term", weight: 1.0 },
    { id: "agent-runtime", label: "Agent Runtime", type: "concept" as const, tier: "long-term", weight: 0.9 },
    { id: "multi-agent", label: "Multi-Agent Systems", type: "concept" as const, tier: "graph", weight: 0.85 },
    { id: "memory", label: "Memory Architecture", type: "concept" as const, tier: "graph", weight: 0.8 },
    { id: "rag", label: "RAG Pipeline", type: "concept" as const, tier: "graph", weight: 0.75 },
    { id: "llm", label: "LLM", type: "entity" as const, tier: "long-term", weight: 0.95 },
    { id: "anthropic", label: "Anthropic", type: "entity" as const, tier: "long-term", weight: 0.8 },
    { id: "openai-ent", label: "OpenAI", type: "entity" as const, tier: "long-term", weight: 0.75 },
    { id: "react", label: "React", type: "skill" as const, tier: "long-term", weight: 0.85 },
    { id: "dashboard", label: "Dashboard", type: "project" as const, tier: "daily", weight: 0.9 },
    { id: "zustand", label: "Zustand", type: "skill" as const, tier: "daily", weight: 0.6 },
    { id: "tailwind", label: "Tailwind CSS", type: "skill" as const, tier: "daily", weight: 0.65 },
    { id: "websocket", label: "WebSocket", type: "concept" as const, tier: "graph", weight: 0.55 },
    { id: "auth", label: "Authentication", type: "concept" as const, tier: "graph", weight: 0.6 },
    { id: "jwt", label: "JWT", type: "entity" as const, tier: "graph", weight: 0.5 },
    { id: "startup", label: "Startup", type: "entity" as const, tier: "long-term", weight: 0.65 },
  ];

  const cx = 400, cy = 300;
  const nodes: GraphNode[] = rawNodes.map((n, i) => {
    const angle = (i / rawNodes.length) * Math.PI * 2;
    const radius = 120 + Math.random() * 100;
    return { ...n, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, vx: 0, vy: 0 };
  });

  const edges: GraphEdge[] = [
    { source: "openastra", target: "agent-runtime", label: "is_a", strength: 0.9 },
    { source: "openastra", target: "nodejs", label: "built_with", strength: 0.8 },
    { source: "openastra", target: "typescript", label: "built_with", strength: 0.85 },
    { source: "openastra", target: "multi-agent", label: "implements", strength: 0.8 },
    { source: "openastra", target: "memory", label: "has", strength: 0.75 },
    { source: "user", target: "typescript", label: "knows", strength: 0.9 },
    { source: "user", target: "python", label: "knows", strength: 0.85 },
    { source: "user", target: "rust", label: "knows", strength: 0.7 },
    { source: "user", target: "startup", label: "works_at", strength: 0.65 },
    { source: "user", target: "openastra", label: "authors", strength: 1.0 },
    { source: "agent-runtime", target: "llm", label: "uses", strength: 0.9 },
    { source: "llm", target: "anthropic", label: "provider", strength: 0.8 },
    { source: "llm", target: "openai-ent", label: "provider", strength: 0.75 },
    { source: "dashboard", target: "react", label: "built_with", strength: 0.85 },
    { source: "dashboard", target: "zustand", label: "uses", strength: 0.6 },
    { source: "dashboard", target: "tailwind", label: "uses", strength: 0.65 },
    { source: "dashboard", target: "openastra", label: "part_of", strength: 0.9 },
    { source: "multi-agent", target: "rag", label: "includes", strength: 0.7 },
    { source: "memory", target: "rag", label: "feeds", strength: 0.75 },
    { source: "agent-runtime", target: "websocket", label: "uses", strength: 0.55 },
    { source: "auth", target: "jwt", label: "uses", strength: 0.6 },
    { source: "dashboard", target: "auth", label: "has", strength: 0.6 },
  ];

  return { nodes, edges };
}

function simulate(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): GraphNode[] {
  const updated = nodes.map((n) => ({ ...n }));
  const k = 80;

  for (let i = 0; i < updated.length; i++) {
    for (let j = i + 1; j < updated.length; j++) {
      const dx = updated[j]!.x - updated[i]!.x;
      const dy = updated[j]!.y - updated[i]!.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (k * k) / dist;
      const fx = (dx / dist) * force * 0.01;
      const fy = (dy / dist) * force * 0.01;
      updated[i]!.vx -= fx;
      updated[i]!.vy -= fy;
      updated[j]!.vx += fx;
      updated[j]!.vy += fy;
    }
  }

  for (const edge of edges) {
    const src = updated.find((n) => n.id === edge.source);
    const tgt = updated.find((n) => n.id === edge.target);
    if (!src || !tgt) continue;
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - k) * 0.005 * edge.strength;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    src.vx += fx;
    src.vy += fy;
    tgt.vx -= fx;
    tgt.vy -= fy;
  }

  for (const node of updated) {
    node.vx *= 0.85;
    node.vy *= 0.85;
    node.x += node.vx;
    node.y += node.vy;
    node.x = Math.max(40, Math.min(width - 40, node.x));
    node.y = Math.max(40, Math.min(height - 40, node.y));
  }

  return updated;
}

export function MemoryGraphPage() {
  const [data] = useState(() => createMockGraph());
  const [nodes, setNodes] = useState(data.nodes);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const svgRef = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);
  const width = 800;
  const height = 600;

  const step = useCallback(() => {
    setNodes((prev) => simulate(prev, data.edges, width, height));
    animRef.current = requestAnimationFrame(step);
  }, [data.edges]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animRef.current);
  }, [step]);

  const filteredNodes = typeFilter === "all" ? nodes : nodes.filter((n) => n.type === typeFilter);
  const filteredIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = data.edges.filter((e) => filteredIds.has(e.source) && filteredIds.has(e.target));

  const nodeEdges = selectedNode
    ? data.edges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];
  const connectedLabels = selectedNode
    ? nodeEdges.map((e) => {
        const otherId = e.source === selectedNode.id ? e.target : e.source;
        const other = nodes.find((n) => n.id === otherId);
        return { label: other?.label ?? otherId, relation: e.label, direction: e.source === selectedNode.id ? "out" : "in" };
      })
    : [];

  const types = ["all", "entity", "concept", "person", "project", "skill"];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Memory Graph</h1>
        <p className="text-sm text-zinc-500">Interactive visualization of entity relationships in agent memory</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Nodes", value: nodes.length, color: "text-sky-400" },
          { label: "Edges", value: data.edges.length, color: "text-violet-400" },
          { label: "Entity Types", value: 5, color: "text-emerald-400" },
          { label: "Graph Density", value: `${((data.edges.length * 2) / (nodes.length * (nodes.length - 1)) * 100).toFixed(1)}%`, color: "text-amber-400" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2">
              <Brain className={cn("h-4 w-4", s.color)} />
              <span className="text-xs text-zinc-500">{s.label}</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-1">
          <Filter className="ml-2 h-3 w-3 text-zinc-500" />
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                typeFilter === t ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-1">
          <button onClick={() => setZoom((z) => Math.min(2, z + 0.2))} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"><ZoomIn className="h-3.5 w-3.5" /></button>
          <span className="px-1 text-[10px] text-zinc-500">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"><ZoomOut className="h-3.5 w-3.5" /></button>
          <button onClick={() => setZoom(1)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Graph */}
        <div className="flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="w-full"
            style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
          >
            {/* Edges */}
            {filteredEdges.map((edge) => {
              const src = nodes.find((n) => n.id === edge.source);
              const tgt = nodes.find((n) => n.id === edge.target);
              if (!src || !tgt) return null;
              const isHighlighted = selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id);
              return (
                <g key={`${edge.source}-${edge.target}`}>
                  <line
                    x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                    stroke={isHighlighted ? "#38bdf8" : "#3f3f46"}
                    strokeWidth={isHighlighted ? 1.5 : 0.8}
                    opacity={selectedNode && !isHighlighted ? 0.15 : 0.6}
                  />
                  <text
                    x={(src.x + tgt.x) / 2}
                    y={(src.y + tgt.y) / 2 - 4}
                    fill={isHighlighted ? "#7dd3fc" : "#52525b"}
                    fontSize={8}
                    textAnchor="middle"
                    opacity={isHighlighted ? 1 : 0.5}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {filteredNodes.map((node) => {
              const colors = NODE_COLORS[node.type] ?? NODE_COLORS.entity!;
              const r = 8 + node.weight * 12;
              const isSelected = selectedNode?.id === node.id;
              const isConnected = selectedNode && data.edges.some(
                (e) => (e.source === selectedNode.id && e.target === node.id) || (e.target === selectedNode.id && e.source === node.id),
              );
              const dimmed = selectedNode && !isSelected && !isConnected;
              return (
                <g
                  key={node.id}
                  onClick={() => setSelectedNode(isSelected ? null : node)}
                  className="cursor-pointer"
                  opacity={dimmed ? 0.2 : 1}
                >
                  {isSelected && (
                    <circle cx={node.x} cy={node.y} r={r + 4} fill="none" stroke={colors.stroke} strokeWidth={1.5} opacity={0.5} />
                  )}
                  <circle
                    cx={node.x} cy={node.y} r={r}
                    fill={colors.fill}
                    fillOpacity={0.2}
                    stroke={colors.stroke}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  <text
                    x={node.x} y={node.y + r + 12}
                    fill={colors.text}
                    fontSize={10}
                    fontWeight={isSelected ? 600 : 400}
                    textAnchor="middle"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Detail panel */}
        <div className="w-full lg:w-72">
          {selectedNode ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: NODE_COLORS[selectedNode.type]?.fill }}
                />
                <h3 className="text-sm font-semibold">{selectedNode.label}</h3>
              </div>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-zinc-500">Type</span><span className="capitalize text-zinc-300">{selectedNode.type}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Tier</span><span className="text-zinc-300">{selectedNode.tier}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Weight</span><span className="text-zinc-300">{selectedNode.weight.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Connections</span><span className="text-zinc-300">{connectedLabels.length}</span></div>
              </div>
              <div>
                <h4 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600">Relationships</h4>
                <div className="space-y-1">
                  {connectedLabels.map((c, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[11px]">
                      <span className={cn("text-[9px]", c.direction === "out" ? "text-sky-500" : "text-emerald-500")}>
                        {c.direction === "out" ? "→" : "←"}
                      </span>
                      <span className="text-zinc-500">{c.relation}</span>
                      <span className="text-zinc-300">{c.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <p className="text-xs text-zinc-500">Click a node to inspect its relationships and metadata.</p>
              {/* Legend */}
              <div className="mt-4 space-y-1.5">
                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Node Types</p>
                {Object.entries(NODE_COLORS).map(([type, colors]) => (
                  <div key={type} className="flex items-center gap-2 text-[11px]">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors.fill }} />
                    <span className="capitalize text-zinc-400">{type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
