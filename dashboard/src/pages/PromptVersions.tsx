import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save, Search, FileText, History } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn, formatRelativeTime } from "@/lib/utils";
import { mockAgents, mockPromptVersions } from "@/hooks/use-mock-data";
import type { Agent, PromptVersion } from "@/types/api";

interface PromptVersionsPayload {
  agents: Agent[];
  versions: PromptVersion[];
  offline: boolean;
}

function nextVersionNumber(versions: PromptVersion[]): number {
  return versions.reduce((max, version) => Math.max(max, version.version), 0) + 1;
}

export function PromptVersionsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("orchestrator");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [localVersions, setLocalVersions] = useState<PromptVersion[]>([]);
  const [offline, setOffline] = useState(false);

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ["prompt-version-agents"],
    queryFn: async (): Promise<{ agents: Agent[]; offline: boolean }> => {
      try {
        const agents = await api.agents.list();
        return { agents, offline: false };
      } catch {
        return { agents: mockAgents, offline: true };
      }
    },
  });

  const agents = agentsData?.agents ?? mockAgents;

  useEffect(() => {
    if (agents.length > 0 && !agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(agents[0]!.id);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    setSelectedVersionId(null);
  }, [selectedAgentId]);

  const currentAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ["prompt-versions", selectedAgentId],
    queryFn: async (): Promise<PromptVersionsPayload> => {
      try {
        const response = await api.promptVersions.list(selectedAgentId);
        return { agents, versions: response.versions, offline: false };
      } catch {
        return {
          agents,
          versions: mockPromptVersions[selectedAgentId] ?? [],
          offline: true,
        };
      }
    },
    enabled: Boolean(selectedAgentId),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (data) {
      setLocalVersions(data.versions);
      setOffline(data.offline || agentsData?.offline || false);
      const fallbackPrompt =
        data.versions[0]?.systemPrompt ??
        currentAgent?.systemPromptTemplate ??
        "You are a helpful agent.";
      setDraftPrompt(fallbackPrompt);
      setDraftLabel(data.versions[0]?.label ?? "");
      if (!selectedVersionId) {
        setSelectedVersionId(data.versions[0]?.id ?? null);
      }
    }
  }, [agentsData?.offline, currentAgent?.systemPromptTemplate, data, selectedVersionId]);

  const selectedVersion = useMemo(
    () =>
      localVersions.find((version) => version.id === selectedVersionId) ??
      localVersions[0] ??
      null,
    [localVersions, selectedVersionId],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      try {
        const created = await api.promptVersions.create(selectedAgentId, {
          systemPrompt: draftPrompt,
          label: draftLabel || undefined,
        });
        return { created, offline: false };
      } catch {
        return {
          created: {
            id: `local-${Date.now()}`,
            agentId: selectedAgentId,
            workspaceId: "local",
            version: nextVersionNumber(localVersions),
            label: draftLabel || null,
            systemPrompt: draftPrompt,
            createdBy: "local-dashboard",
            createdAt: new Date().toISOString(),
          } satisfies PromptVersion,
          offline: true,
        };
      }
    },
    onSuccess: ({ created, offline: mutationOffline }) => {
      setLocalVersions((current) => [created, ...current.filter((version) => version.version !== created.version)]);
      setOffline(mutationOffline);
      toast.success(mutationOffline ? "Version saved locally" : "Version saved");
      void queryClient.invalidateQueries({ queryKey: ["prompt-versions", selectedAgentId] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (version: PromptVersion) => {
      try {
        await api.promptVersions.restore(selectedAgentId, version.version);
        return { version, offline: false };
      } catch {
        return { version, offline: true };
      }
    },
    onSuccess: ({ version, offline: mutationOffline }) => {
      setDraftPrompt(version.systemPrompt);
      setDraftLabel(version.label ?? "");
      setSelectedVersionId(version.id);
      setOffline(mutationOffline);
      toast.success(mutationOffline ? "Restored locally" : "Prompt restored");
    },
  });

  const filteredVersions = localVersions.filter((version) => {
    const haystack = `${version.version} ${version.label ?? ""} ${version.systemPrompt}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Prompt Versions</h1>
          <p className="text-sm text-zinc-500">
            Review prompt history, save a new version, or roll back quickly
          </p>
        </div>
        <div className="flex items-center gap-3">
          {(offline || agentsData?.offline) && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              Fallback data
            </span>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search versions..."
              className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {agentsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
        ) : (
          <>
            <StatCard title="Agents" value={agents.length} icon={FileText} change="Versioned prompts available" />
            <StatCard title="Versions" value={localVersions.length} icon={History} change="Historical snapshots" />
            <StatCard title="Current Draft" value={draftLabel || "Untitled"} icon={Save} change="Working copy" />
            <StatCard title="Offline Mode" value={offline ? "Yes" : "No"} icon={RefreshCw} change={offline ? "Using fallback versions" : "Live API"} changeType={offline ? "neutral" : "positive"} />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-300">Agents</h2>
            <div className="space-y-2">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                    selectedAgentId === agent.id
                      ? "border-sky-500/40 bg-sky-500/5"
                      : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-zinc-200">{agent.displayName}</p>
                      <p className="text-[10px] font-mono text-zinc-500">{agent.id}</p>
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-300">
              Save New Version
            </h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                  Label
                </label>
                <input
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="Optional version label"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                  Prompt
                </label>
                <textarea
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  rows={8}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                />
              </div>
              <button
                onClick={() => saveMutation.mutate()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
              >
                <Save className="h-3.5 w-3.5" />
                Save Version
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4 xl:col-span-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-zinc-300">
                  Version History
                </h2>
                <p className="text-xs text-zinc-500">
                  {currentAgent?.displayName ?? "Selected agent"} prompt revisions
                </p>
              </div>
              <StatusBadge status={offline ? "degraded" : "healthy"} />
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="h-4 w-24 rounded bg-zinc-800" />
                    <div className="mt-2 h-3 w-full rounded bg-zinc-800" />
                    <div className="mt-2 h-3 w-2/3 rounded bg-zinc-800" />
                  </div>
                ))}
              </div>
            ) : filteredVersions.length > 0 ? (
              <div className="space-y-3">
                {filteredVersions.map((version) => (
                  <div
                    key={version.id}
                    onClick={() => setSelectedVersionId(version.id)}
                    className="cursor-pointer rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 transition-colors hover:border-zinc-700"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-zinc-200">
                            v{version.version}
                          </p>
                          {version.label && (
                            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                              {version.label}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          Created {formatRelativeTime(version.createdAt)}
                        </p>
                      </div>
                      <button
                        onClick={() => restoreMutation.mutate(version)}
                        className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
                      >
                        Restore
                      </button>
                    </div>
                    <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
                      {version.systemPrompt}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={History}
                title="No versions found"
                description="Save a prompt to start building history."
              />
            )}
          </div>

          {selectedVersion && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <h2 className="mb-3 text-sm font-semibold text-zinc-300">
                Selected Version
              </h2>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Version</span>
                  <span className="text-zinc-300">v{selectedVersion.version}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Created By</span>
                  <span className="text-zinc-300">{selectedVersion.createdBy ?? "unknown"}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Label</span>
                  <span className="text-zinc-300">{selectedVersion.label ?? "none"}</span>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Prompt Snapshot</p>
                  <pre className="max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-300">
                    {selectedVersion.systemPrompt}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
