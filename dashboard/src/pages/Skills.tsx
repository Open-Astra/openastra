import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch,
  Search,
  ShieldCheck,
  Workflow,
  TriangleAlert,
  Layers3,
} from "lucide-react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn } from "@/lib/utils";
import {
  mockSkillGraph,
  mockSkillGraphValidation,
} from "@/hooks/use-mock-data";
import type {
  SkillGraph,
  SkillGraphValidation,
} from "@/types/api";

interface SkillGraphPayload {
  graph: SkillGraph;
  validation: SkillGraphValidation;
  skillCount: number;
  toolCount: number;
  offline: boolean;
}

function scoreCategory(nodes: SkillGraph["nodes"], category: string): number {
  return nodes.filter((node) => node.category === category).length;
}

export function SkillsPage() {
  const [search, setSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["skills-graph"],
    queryFn: async (): Promise<SkillGraphPayload> => {
      try {
        const [graph, validation, catalog] = await Promise.all([
          api.skills.graph(),
          api.skills.graphValidation(),
          api.skills.list(),
        ]);

        return {
          graph,
          validation,
          skillCount: catalog.skillCount,
          toolCount: catalog.toolCount,
          offline: false,
        };
      } catch {
        return {
          graph: mockSkillGraph,
          validation: mockSkillGraphValidation,
          skillCount: mockSkillGraph.nodes.length,
          toolCount: mockSkillGraph.nodes.reduce(
            (sum, node) => sum + node.tools.length,
            0,
          ),
          offline: true,
        };
      }
    },
    refetchInterval: 30_000,
  });

  const payload = data ?? {
    graph: mockSkillGraph,
    validation: mockSkillGraphValidation,
    skillCount: mockSkillGraph.nodes.length,
    toolCount: mockSkillGraph.nodes.reduce(
      (sum, node) => sum + node.tools.length,
      0,
    ),
    offline: true,
  };

  const filteredNodes = payload.graph.nodes.filter((node) => {
    const haystack = `${node.id} ${node.name} ${node.category} ${node.tools.join(" ")}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  useEffect(() => {
    if (!selectedNodeId && filteredNodes[0]) {
      setSelectedNodeId(filteredNodes[0].id);
    }
    if (selectedNodeId && !filteredNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(filteredNodes[0]?.id ?? null);
    }
  }, [filteredNodes, selectedNodeId]);

  const selectedNode =
    filteredNodes.find((node) => node.id === selectedNodeId) ??
    filteredNodes[0] ??
    payload.graph.nodes[0] ??
    null;

  const inbound = selectedNode
    ? payload.graph.edges.filter((edge) => edge.to === selectedNode.id)
    : [];
  const outbound = selectedNode
    ? payload.graph.edges.filter((edge) => edge.from === selectedNode.id)
    : [];

  const categories = [...new Set(payload.graph.nodes.map((node) => node.category))];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Skills Graph</h1>
          <p className="text-sm text-zinc-500">
            Dependency coverage, graph validation, and skill topology
          </p>
        </div>
        <div className="flex items-center gap-3">
          {payload.offline && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              Fallback data
            </span>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Skills"
            value={payload.skillCount}
            icon={Workflow}
            change={`${payload.graph.nodes.length} nodes in graph`}
          />
          <StatCard
            title="Tools"
            value={payload.toolCount}
            icon={GitBranch}
            change={`${payload.graph.edges.length} dependency edges`}
          />
          <StatCard
            title="Valid Graph"
            value={payload.validation.valid ? "Yes" : "No"}
            icon={ShieldCheck}
            change={payload.validation.valid ? "Ready to ship" : "Needs attention"}
            changeType={payload.validation.valid ? "positive" : "negative"}
          />
          <StatCard
            title="Warnings"
            value={payload.validation.warnings.length}
            icon={TriangleAlert}
            change={payload.validation.warnings.length > 0 ? "Review non-blocking issues" : "No warnings"}
            changeType={payload.validation.warnings.length > 0 ? "neutral" : "positive"}
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-zinc-300">Skill Topology</h2>
                <p className="text-xs text-zinc-500">
                  Grouped by category and searchable by tool or skill ID
                </p>
              </div>
              <StatusBadge status={payload.validation.valid ? "healthy" : "degraded"} />
            </div>

            {filteredNodes.length > 0 ? (
              <div className="space-y-3">
                {filteredNodes.map((node) => {
                  const isSelected = node.id === selectedNode?.id;
                  const outgoing = payload.graph.edges.filter((edge) => edge.from === node.id);
                  const incoming = payload.graph.edges.filter((edge) => edge.to === node.id);

                  return (
                    <button
                      key={node.id}
                      onClick={() => setSelectedNodeId(node.id)}
                      className={cn(
                        "w-full rounded-xl border p-4 text-left transition-colors",
                        isSelected
                          ? "border-sky-500/40 bg-sky-500/5"
                          : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700",
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-zinc-200">
                              {node.name}
                            </span>
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                              {node.category}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-[10px] text-zinc-500">
                            {node.id} · v{node.version}
                          </p>
                        </div>
                        <div className="text-right text-[10px] text-zinc-500">
                          <p>{incoming.length} inbound</p>
                          <p>{outgoing.length} outbound</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {node.tools.map((tool) => (
                          <span
                            key={tool}
                            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={Layers3}
                title="No skills match"
                description="Try a different search term or clear the filter."
              />
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-300">
              Validation
            </h2>
            <div className="space-y-3 text-xs">
              {payload.validation.errors.length > 0 ? (
                payload.validation.errors.map((error) => (
                  <div key={error} className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-red-300">
                    {error}
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-emerald-300">
                  Graph validation passed.
                </div>
              )}

              {payload.validation.warnings.length > 0 && (
                <div className="space-y-2">
                  {payload.validation.warnings.map((warning) => (
                    <div
                      key={warning}
                      className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-amber-300"
                    >
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              {payload.validation.cycles.length > 0 && (
                <div className="space-y-2">
                  {payload.validation.cycles.map((cycle, index) => (
                    <div
                      key={`${cycle.join("-")}-${index}`}
                      className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-red-300"
                    >
                      Cycle: {cycle.join(" -> ")}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selectedNode && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-300">
                Selected Skill
              </h2>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Name</span>
                  <span className="text-zinc-200">{selectedNode.name}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Category</span>
                  <span className="text-zinc-200">{selectedNode.category}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Version</span>
                  <span className="text-zinc-200">{selectedNode.version}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Inbound Edges</span>
                  <span className="text-zinc-200">{inbound.length}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Outbound Edges</span>
                  <span className="text-zinc-200">{outbound.length}</span>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Composes</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedNode.composes.length > 0 ? selectedNode.composes.map((item) => (
                      <span key={item} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] text-zinc-400">
                        {item}
                      </span>
                    )) : (
                      <span className="text-zinc-600">None</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Requires</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedNode.requires.length > 0 ? selectedNode.requires.map((item) => (
                      <span key={item} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] text-zinc-400">
                        {item}
                      </span>
                    )) : (
                      <span className="text-zinc-600">None</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Tools</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedNode.tools.map((tool) => (
                      <span key={tool} className="rounded-md bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-2">
                  {categories.map((category) => (
                    <div key={category} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-center">
                      <p className="text-[10px] text-zinc-500">{category}</p>
                      <p className="text-sm font-semibold text-zinc-200">
                        {scoreCategory(payload.graph.nodes, category)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
