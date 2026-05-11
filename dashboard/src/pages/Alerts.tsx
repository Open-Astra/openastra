import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Bot,
  Clock,
  Filter,
  Search,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn, formatRelativeTime } from "@/lib/utils";
import { mockAnomalyAlerts } from "@/hooks/use-mock-data";

export function AlertsPage() {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const { data } = useQuery({
    queryKey: ["tool-anomalies"],
    queryFn: async () => {
      try {
        const response = await api.alerts.list(50);
        return { alerts: response.alerts, fallback: false };
      } catch {
        return { alerts: mockAnomalyAlerts, fallback: true };
      }
    },
    refetchInterval: 15_000,
  });

  const alertList = data?.alerts ?? mockAnomalyAlerts;
  const usingFallback = data?.fallback ?? true;
  const [selectedId, setSelectedId] = useState<string | null>(mockAnomalyAlerts[0]?.id ?? null);

  const filtered = useMemo(() => {
    return alertList.filter((alert) => {
      const haystack = `${alert.ruleId} ${alert.ruleName} ${alert.toolName} ${alert.agentId ?? ""} ${alert.description}`.toLowerCase();
      const matchesSearch = haystack.includes(search.toLowerCase());
      const matchesSeverity =
        severityFilter === "all" || alert.severity === severityFilter;
      return matchesSearch && matchesSeverity;
    });
  }, [alertList, search, severityFilter]);

  const selected =
    filtered.find((alert) => alert.id === selectedId) ?? filtered[0] ?? null;

  const critical = alertList.filter((alert) => alert.severity === "critical").length;
  const high = alertList.filter((alert) => alert.severity === "high").length;
  const toolCount = new Set(alertList.map((alert) => alert.toolName)).size;
  const affectedAgents = new Set(
    alertList.map((alert) => alert.agentId).filter(Boolean),
  ).size;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Anomaly Alerts</h1>
          <p className="text-sm text-zinc-500">
            Tool usage alerts from the runtime anomaly detector
          </p>
        </div>
        <div className="flex items-center gap-3">
          {usingFallback && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              Mock fallback
            </span>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search alerts..."
              className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Critical" value={critical} icon={ShieldAlert} change="Immediate review" />
        <StatCard title="High" value={high} icon={AlertTriangle} change="Investigate next" />
        <StatCard title="Tool Types" value={toolCount} icon={Bot} change="Unique surfaces affected" />
        <StatCard title="Agents Affected" value={affectedAgents} icon={Clock} change="Across the current snapshot" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <span className="w-24">Severity</span>
              <span className="flex-1">Rule</span>
              <span className="w-24 text-center">Tool</span>
              <span className="w-28 text-right">Timestamp</span>
            </div>

            {filtered.length > 0 ? (
              filtered.map((alert) => (
                <button
                  key={alert.id}
                  onClick={() => setSelectedId(alert.id)}
                  className={cn(
                    "flex w-full items-center gap-4 border-b border-zinc-800/50 px-4 py-3 text-left text-xs transition-colors hover:bg-zinc-800/30",
                    selected?.id === alert.id && "bg-zinc-800/40",
                  )}
                >
                  <span className="w-24">
                    <StatusBadge status={alert.severity} />
                  </span>
                  <span className="flex-1">
                    <p className="font-medium text-zinc-200">{alert.ruleName}</p>
                    <p className="mt-0.5 text-[10px] text-zinc-500">{alert.description}</p>
                  </span>
                  <span className="w-24 text-center text-zinc-400">
                    {alert.toolName}
                  </span>
                  <span className="w-28 text-right text-zinc-500">
                    {formatRelativeTime(alert.timestamp)}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState
                icon={Ban}
                title="No alerts found"
                description="No anomaly alerts match the current filters."
              />
            )}
          </div>
        </div>

        <div className="space-y-4">
          {selected ? (
            <div className="sticky top-6 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-200">{selected.ruleName}</h2>
                  <p className="text-xs text-zinc-500">{selected.ruleId}</p>
                </div>
                <StatusBadge status={selected.severity} />
              </div>

              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Tool</span>
                  <span className="text-zinc-300">{selected.toolName}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Agent</span>
                  <span className="text-zinc-300">{selected.agentId ?? "global"}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">User</span>
                  <span className="text-zinc-300">{selected.uid ?? "n/a"}</span>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Metadata</p>
                  <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-300">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-center">
              <p className="text-xs text-zinc-600">
                Select an alert to inspect the detector details
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
