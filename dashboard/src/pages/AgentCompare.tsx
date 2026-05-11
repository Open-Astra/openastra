import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCompare, ChevronDown } from "lucide-react";
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { api } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";
import { mockAgents } from "@/hooks/use-mock-data";
import type { Agent } from "@/types/api";

// Mock token/cost data per agent for the bar chart
const mockUsageData: Record<string, { tokensToday: number; costToday: number }> = {
  orchestrator: { tokensToday: 820_000, costToday: 3.28 },
  researcher: { tokensToday: 410_000, costToday: 1.64 },
  coder: { tokensToday: 1_250_000, costToday: 5.0 },
  writer: { tokensToday: 72_000, costToday: 0.04 },
  "data-analyst": { tokensToday: 290_000, costToday: 0.29 },
};

// Mock reliability percentages per agent
const mockReliability: Record<string, number> = {
  orchestrator: 97,
  researcher: 94,
  coder: 99,
  writer: 82,
  "data-analyst": 96,
};

function getToolsCount(agent: Agent): number {
  return agent.tools.allow?.length ?? 0;
}

function AgentSelector({
  agents,
  selected,
  onChange,
  label,
}: {
  agents: Agent[];
  selected: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="flex-1">
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </label>
      <div className="relative">
        <select
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-3 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
      </div>
    </div>
  );
}

interface ComparisonRow {
  label: string;
  valueA: string;
  valueB: string;
  differs: boolean;
}

function buildRows(a: Agent, b: Agent): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  const add = (label: string, va: string, vb: string) => {
    rows.push({ label, valueA: va, valueB: vb, differs: va !== vb });
  };

  add("Model", a.model.modelId, b.model.modelId);
  add("Provider", a.model.provider, b.model.provider);
  add("Status", a.status, b.status);
  add("Tier", a.tier ?? "-", b.tier ?? "-");
  add("Sessions", String(a.sessionCount), String(b.sessionCount));
  add("Inferences", formatNumber(a.totalInferences), formatNumber(b.totalInferences));
  add("Skills count", String(a.skills.length), String(b.skills.length));
  add("Tools count", String(getToolsCount(a)), String(getToolsCount(b)));
  add("Memory namespace", a.memoryNamespace ?? "-", b.memoryNamespace ?? "-");
  add(
    "Spawning capability",
    a.spawn?.enabled ? `Yes (depth ${a.spawn.maxDepth})` : "No",
    b.spawn?.enabled ? `Yes (depth ${b.spawn.maxDepth})` : "No",
  );

  return rows;
}

export function AgentComparePage() {
  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list().catch(() => mockAgents),
  });

  const agentList = agents ?? mockAgents;

  const [agentAId, setAgentAId] = useState(agentList[0]?.id ?? "orchestrator");
  const [agentBId, setAgentBId] = useState(agentList[1]?.id ?? "researcher");

  const agentA = agentList.find((a) => a.id === agentAId) ?? agentList[0]!;
  const agentB = agentList.find((a) => a.id === agentBId) ?? agentList[1]!;

  const rows = useMemo(() => buildRows(agentA, agentB), [agentA, agentB]);

  // Radar chart data
  const radarData = useMemo(() => {
    const maxSessions = Math.max(agentA.sessionCount, agentB.sessionCount, 1);
    const maxInferences = Math.max(agentA.totalInferences, agentB.totalInferences, 1);
    const maxSkills = Math.max(agentA.skills.length, agentB.skills.length, 1);
    const maxTools = Math.max(getToolsCount(agentA), getToolsCount(agentB), 1);

    return [
      {
        metric: "Sessions",
        A: Math.round((agentA.sessionCount / maxSessions) * 100),
        B: Math.round((agentB.sessionCount / maxSessions) * 100),
      },
      {
        metric: "Inferences",
        A: Math.round((agentA.totalInferences / maxInferences) * 100),
        B: Math.round((agentB.totalInferences / maxInferences) * 100),
      },
      {
        metric: "Skills",
        A: Math.round((agentA.skills.length / maxSkills) * 100),
        B: Math.round((agentB.skills.length / maxSkills) * 100),
      },
      {
        metric: "Tools",
        A: Math.round((getToolsCount(agentA) / maxTools) * 100),
        B: Math.round((getToolsCount(agentB) / maxTools) * 100),
      },
      {
        metric: "Reliability",
        A: mockReliability[agentA.id] ?? 90,
        B: mockReliability[agentB.id] ?? 90,
      },
    ];
  }, [agentA, agentB]);

  // Bar chart data
  const barData = useMemo(() => {
    const usageA = mockUsageData[agentA.id] ?? { tokensToday: 0, costToday: 0 };
    const usageB = mockUsageData[agentB.id] ?? { tokensToday: 0, costToday: 0 };

    return [
      {
        metric: "Tokens (K)",
        A: Math.round(usageA.tokensToday / 1_000),
        B: Math.round(usageB.tokensToday / 1_000),
      },
      {
        metric: "Cost ($)",
        A: usageA.costToday,
        B: usageB.costToday,
      },
    ];
  }, [agentA, agentB]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <GitCompare className="h-5 w-5 text-zinc-400" />
          Agent Comparison
        </h1>
        <p className="text-sm text-zinc-500">
          Compare capabilities and performance of two agents side by side
        </p>
      </div>

      {/* Agent selectors */}
      <div className="flex items-end gap-4">
        <AgentSelector
          agents={agentList}
          selected={agentAId}
          onChange={setAgentAId}
          label="Agent A"
        />
        <div className="pb-2 text-zinc-600">
          <GitCompare className="h-4 w-4" />
        </div>
        <AgentSelector
          agents={agentList}
          selected={agentBId}
          onChange={setAgentBId}
          label="Agent B"
        />
      </div>

      {/* Comparison table */}
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">
                Attribute
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-sky-500">
                {agentA.displayName}
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-violet-500">
                {agentB.displayName}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.label}
                className={cn(
                  "border-b border-zinc-800/50 last:border-0",
                  row.differs ? "bg-amber-500/5" : "bg-zinc-950",
                )}
              >
                <td className="px-4 py-2 text-xs font-medium text-zinc-400">
                  {row.label}
                </td>
                <td
                  className={cn(
                    "px-4 py-2 font-mono text-xs",
                    row.differs ? "text-sky-300" : "text-zinc-300",
                  )}
                >
                  {row.valueA}
                </td>
                <td
                  className={cn(
                    "px-4 py-2 font-mono text-xs",
                    row.differs ? "text-violet-300" : "text-zinc-300",
                  )}
                >
                  {row.valueB}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Radar chart */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-4 text-sm font-semibold text-zinc-300">
            Capability Radar
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <RadarChart data={radarData}>
              <PolarGrid stroke="#3f3f46" />
              <PolarAngleAxis
                dataKey="metric"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
              />
              <Radar
                name={agentA.displayName}
                dataKey="A"
                stroke="#0ea5e9"
                fill="#0ea5e9"
                fillOpacity={0.15}
              />
              <Radar
                name={agentB.displayName}
                dataKey="B"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.15}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#a1a1aa" }}
              />
            </RadarChart>
          </ResponsiveContainer>
          <div className="mt-2 flex items-center justify-center gap-6 text-[10px]">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-sky-500" />
              <span className="text-zinc-400">{agentA.displayName}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-violet-500" />
              <span className="text-zinc-400">{agentB.displayName}</span>
            </span>
          </div>
        </div>

        {/* Bar chart */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-4 text-sm font-semibold text-zinc-300">
            Token Usage & Cost
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
              <XAxis
                dataKey="metric"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                axisLine={{ stroke: "#3f3f46" }}
                tickLine={{ stroke: "#3f3f46" }}
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                axisLine={{ stroke: "#3f3f46" }}
                tickLine={{ stroke: "#3f3f46" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#a1a1aa" }}
              />
              <Bar
                dataKey="A"
                name={agentA.displayName}
                fill="#0ea5e9"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="B"
                name={agentB.displayName}
                fill="#8b5cf6"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2 flex items-center justify-center gap-6 text-[10px]">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-sky-500" />
              <span className="text-zinc-400">{agentA.displayName}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-violet-500" />
              <span className="text-zinc-400">{agentB.displayName}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
