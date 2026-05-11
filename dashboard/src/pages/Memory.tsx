import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Search,
  Database,
  Clock,
  GitBranch,
  Workflow,
  Sparkles,
  Filter,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { mockMemoryEntries, mockAgents } from "@/hooks/use-mock-data";
import type { MemoryTier } from "@/types/api";

const tierConfig: Record<MemoryTier, { icon: typeof Brain; color: string; bg: string; label: string }> = {
  ephemeral: { icon: Clock, color: "text-sky-400", bg: "bg-sky-500/10", label: "Ephemeral" },
  daily: { icon: Sparkles, color: "text-violet-400", bg: "bg-violet-500/10", label: "Daily" },
  "long-term": { icon: Database, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Long-term" },
  graph: { icon: GitBranch, color: "text-amber-400", bg: "bg-amber-500/10", label: "Graph" },
  procedural: { icon: Workflow, color: "text-rose-400", bg: "bg-rose-500/10", label: "Procedural" },
};

export function MemoryPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTier, setSelectedTier] = useState<string>("all");
  const [selectedAgent, setSelectedAgent] = useState<string>("all");

  const { data: memories } = useQuery({
    queryKey: ["memory", selectedAgent, selectedTier, searchQuery],
    queryFn: () =>
      api.memory
        .list({
          agentId: selectedAgent !== "all" ? selectedAgent : undefined,
          tier: selectedTier !== "all" ? selectedTier : undefined,
          query: searchQuery || undefined,
        })
        .catch(() => mockMemoryEntries),
  });

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list().catch(() => mockAgents),
  });

  const memoryList = memories ?? mockMemoryEntries;
  const agentList = agents ?? mockAgents;

  const filtered = memoryList.filter((m) => {
    const matchesTier = selectedTier === "all" || m.tier === selectedTier;
    const matchesSearch =
      !searchQuery ||
      m.content.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesTier && matchesSearch;
  });

  const tierCounts = memoryList.reduce(
    (acc, m) => {
      acc[m.tier] = (acc[m.tier] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">Memory Explorer</h1>
        <p className="text-sm text-zinc-500">
          Browse and search across the 5-tier memory system
        </p>
      </div>

      {/* Tier overview cards */}
      <div className="grid gap-3 sm:grid-cols-5">
        {(Object.entries(tierConfig) as [MemoryTier, typeof tierConfig.ephemeral][]).map(
          ([tier, config]) => {
            const Icon = config.icon;
            return (
              <button
                key={tier}
                onClick={() =>
                  setSelectedTier(selectedTier === tier ? "all" : tier)
                }
                className={cn(
                  "rounded-xl border p-3 text-left transition-all",
                  selectedTier === tier
                    ? "border-sky-500/50 bg-zinc-800/50"
                    : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700",
                )}
              >
                <div className="flex items-center gap-2">
                  <div className={cn("rounded-lg p-1.5", config.bg)}>
                    <Icon className={cn("h-3.5 w-3.5", config.color)} />
                  </div>
                  <span className="text-xs font-medium text-zinc-300">
                    {config.label}
                  </span>
                </div>
                <p className="mt-2 text-lg font-bold">
                  {tierCounts[tier] ?? 0}
                </p>
              </button>
            );
          },
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search memories..."
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
          >
            <option value="all">All Agents</option>
            {agentList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Memory entries */}
      <div className="space-y-2">
        {filtered.length > 0 ? (
          filtered.map((entry) => {
            const config = tierConfig[entry.tier];
            const Icon = config.icon;
            return (
              <div
                key={entry.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-start gap-3">
                  <div className={cn("mt-0.5 rounded-lg p-1.5", config.bg)}>
                    <Icon className={cn("h-3.5 w-3.5", config.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                          config.bg,
                          config.color,
                        )}
                      >
                        {config.label}
                      </span>
                      {entry.category && (
                        <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                          {entry.category}
                        </span>
                      )}
                      {entry.weight != null && (
                        <span className="text-[10px] text-zinc-600">
                          weight: {entry.weight}
                        </span>
                      )}
                      {entry.score != null && (
                        <span className="text-[10px] text-zinc-600">
                          score: {entry.score}
                        </span>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-zinc-300">
                      {entry.content}
                    </p>
                    <p className="mt-1 text-[10px] text-zinc-600">
                      {formatRelativeTime(entry.timestamp)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <EmptyState
            icon={Brain}
            title="No memories found"
            description="No memory entries match your current filters. Try adjusting the tier or search query."
          />
        )}
      </div>
    </div>
  );
}
