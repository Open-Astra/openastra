import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Activity,
  Zap,
  Coins,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  AreaChart,
  Area,
} from "recharts";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { LiveEventFeed } from "@/components/dashboard/LiveEventFeed";
import { formatNumber, formatBytes, formatDuration } from "@/lib/utils";
import { mockDashboardStats } from "@/hooks/use-mock-data";

export function OverviewPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => api.dashboard.stats().catch(() => mockDashboardStats),
    refetchInterval: 15_000,
  });

  const s = stats ?? mockDashboardStats;

  const providerChartData = s.topProviders.map((p) => ({
    name: p.name,
    requests: p.requests,
    tokens: Math.round(p.tokens / 1_000),
  }));

  const cpuChartData = s.cpuHistory.map((v: number, i: number) => ({ time: `${i}h`, cpu: v, mem: s.memoryHistory[i] ?? 0 }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-zinc-500">
          Real-time overview of your OpenAstra runtime
        </p>
      </div>

      {/* KPI Cards */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Active Agents"
            value={s.activeAgents}
            icon={Bot}
            change={`${s.activeSwarms} swarm${s.activeSwarms !== 1 ? "s" : ""} running`}
            sparklineData={s.inferenceHistory.slice(0, 12)}
          />
          <StatCard
            title="Running Sessions"
            value={s.runningSessions}
            icon={Activity}
            change="Real-time"
            changeType="positive"
            sparklineData={s.inferenceHistory.slice(12)}
          />
          <StatCard
            title="Inferences Today"
            value={formatNumber(s.totalInferencesToday)}
            icon={Zap}
            change={`${formatNumber(s.totalTokensToday)} tokens`}
            sparklineData={s.inferenceHistory}
          />
          <StatCard
            title="Cost Today"
            value={`$${s.totalCostToday.toFixed(2)}`}
            icon={Coins}
            change="Across all providers"
          />
        </div>
      )}

      {/* System Health + Event Feed */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* System Health */}
        <div className="space-y-4 lg:col-span-1">
          <h2 className="text-sm font-semibold text-zinc-300">System Health</h2>

          {/* CPU */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">CPU</span>
              </div>
              <span className="text-sm font-bold">{s.systemHealth.cpu.usage}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{ width: `${s.systemHealth.cpu.usage}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              {s.systemHealth.cpu.cores} cores
            </p>
          </div>

          {/* Memory */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MemoryStick className="h-4 w-4 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Memory</span>
              </div>
              <span className="text-sm font-bold">
                {s.systemHealth.memory.percentage}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-violet-500 transition-all"
                style={{ width: `${s.systemHealth.memory.percentage}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              {formatBytes(s.systemHealth.memory.used)} /{" "}
              {formatBytes(s.systemHealth.memory.total)}
            </p>
          </div>

          {/* Disk */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Disk</span>
              </div>
              <span className="text-sm font-bold">
                {s.systemHealth.disk.percentage}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${s.systemHealth.disk.percentage}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              {formatBytes(s.systemHealth.disk.used)} /{" "}
              {formatBytes(s.systemHealth.disk.total)}
            </p>
          </div>

          {/* Uptime */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-zinc-500" />
                <span className="text-xs font-medium text-zinc-400">Uptime</span>
              </div>
              <StatusBadge status="healthy" />
            </div>
            <p className="mt-2 text-lg font-bold">
              {formatDuration(s.systemHealth.uptime)}
            </p>
          </div>
        </div>

        {/* Live Event Feed */}
        <div className="lg:col-span-2">
          <LiveEventFeed />
        </div>
      </div>

      {/* Charts row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Provider Usage */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-4 text-sm font-semibold text-zinc-300">
            Provider Usage Today
          </h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={providerChartData}>
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="requests" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CPU & Memory Over Time */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-4 text-sm font-semibold text-zinc-300">
            Resource Usage (24h)
          </h2>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cpuChartData}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #3f3f46",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  stroke="#0ea5e9"
                  fill="url(#cpuGrad)"
                  strokeWidth={1.5}
                  dot={false}
                  name="CPU %"
                />
                <Area
                  type="monotone"
                  dataKey="mem"
                  stroke="#8b5cf6"
                  fill="url(#memGrad)"
                  strokeWidth={1.5}
                    dot={false}
                    name="Memory %"
                  />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Memory Tiers */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-4 text-sm font-semibold text-zinc-300">
          Memory Usage by Tier
        </h2>
        <div className="grid gap-3 sm:grid-cols-5">
          {(
            [
              { tier: "Ephemeral", count: s.memoryUsage.ephemeral, color: "bg-sky-500" },
              { tier: "Daily", count: s.memoryUsage.daily, color: "bg-violet-500" },
              { tier: "Long-term", count: s.memoryUsage.longTerm, color: "bg-emerald-500" },
              { tier: "Graph", count: s.memoryUsage.graph, color: "bg-amber-500" },
              { tier: "Procedural", count: s.memoryUsage.procedural, color: "bg-rose-500" },
            ] as const
          ).map((item) => (
            <div
              key={item.tier}
              className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-center"
            >
              <div className={`mx-auto mb-2 h-1 w-8 rounded-full ${item.color}`} />
              <p className="text-lg font-bold">{formatNumber(item.count)}</p>
              <p className="text-[10px] text-zinc-500">{item.tier}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
