import { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
  Legend,
} from "recharts";
import {
  DollarSign,
  TrendingUp,
  Server,
  Bot,
} from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import { mockAgents } from "@/hooks/use-mock-data";

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#0ea5e9",  // sky-500
  openai: "#10b981",     // emerald-500
  google: "#f59e0b",     // amber-500
  groq: "#8b5cf6",       // violet-500
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  groq: "Groq",
};

function generateMockCostHistory(days: number) {
  const data = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    data.push({
      date: date.toISOString().slice(0, 10),
      anthropic: parseFloat((Math.random() * 40 + 10).toFixed(2)),
      openai: parseFloat((Math.random() * 30 + 5).toFixed(2)),
      google: parseFloat((Math.random() * 20 + 3).toFixed(2)),
      groq: parseFloat((Math.random() * 10 + 1).toFixed(2)),
    });
  }
  return data;
}

const mockCostHistory = generateMockCostHistory(30);

const mockAgentCosts = mockAgents.map((agent) => ({
  name: agent.displayName,
  cost: parseFloat((Math.random() * 120 + 10).toFixed(2)),
  requests: Math.floor(Math.random() * 500 + 50),
}));

type DateRange = "7d" | "30d" | "90d";

export function CostsPage() {
  const [dateRange, setDateRange] = useState<DateRange>("30d");

  const filteredHistory = useMemo(() => {
    const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
    if (days <= 30) {
      return mockCostHistory.slice(-days);
    }
    // For 90d, generate extra data
    return generateMockCostHistory(days);
  }, [dateRange]);

  const totalCost = useMemo(() => {
    return filteredHistory.reduce(
      (sum, day) => sum + day.anthropic + day.openai + day.google + day.groq,
      0
    );
  }, [filteredHistory]);

  const avgCostPerDay = totalCost / filteredHistory.length;

  const providerTotals = useMemo(() => {
    const totals: Record<string, { cost: number; requests: number; tokens: number }> = {
      anthropic: { cost: 0, requests: 0, tokens: 0 },
      openai: { cost: 0, requests: 0, tokens: 0 },
      google: { cost: 0, requests: 0, tokens: 0 },
      groq: { cost: 0, requests: 0, tokens: 0 },
    };
    filteredHistory.forEach((day) => {
      totals.anthropic!.cost += day.anthropic;
      totals.openai!.cost += day.openai;
      totals.google!.cost += day.google;
      totals.groq!.cost += day.groq;
    });
    Object.keys(totals).forEach((key) => {
      totals[key]!.requests = Math.floor(Math.random() * 2000 + 200);
      totals[key]!.tokens = Math.floor(Math.random() * 5000000 + 500000);
    });
    return totals;
  }, [filteredHistory]);

  const mostExpensiveProvider = useMemo(() => {
    return Object.entries(providerTotals).sort(
      (a, b) => b[1].cost - a[1].cost
    )[0];
  }, [providerTotals]);

  const mostExpensiveAgent = useMemo(() => {
    return [...mockAgentCosts].sort((a, b) => b.cost - a.cost)[0];
  }, []);

  const pieData = useMemo(() => {
    return Object.entries(providerTotals).map(([key, val]) => ({
      name: PROVIDER_LABELS[key],
      value: parseFloat(val.cost.toFixed(2)),
      color: PROVIDER_COLORS[key],
    }));
  }, [providerTotals]);

  const sortedAgentCosts = useMemo(() => {
    return [...mockAgentCosts].sort((a, b) => b.cost - a.cost);
  }, []);

  const rangeButtons: { label: string; value: DateRange }[] = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Cost Analytics</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Monitor and analyze your spending across providers and agents
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-zinc-900 border border-zinc-800 p-1">
          {rangeButtons.map((btn) => (
            <button
              key={btn.value}
              onClick={() => setDateRange(btn.value)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                dateRange === btn.value
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          icon={<DollarSign className="h-5 w-5 text-sky-500" />}
          label="Total Cost"
          value={`$${formatNumber(totalCost)}`}
          accent="sky"
        />
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-emerald-500" />}
          label="Avg Cost/Day"
          value={`$${formatNumber(avgCostPerDay)}`}
          accent="emerald"
        />
        <SummaryCard
          icon={<Server className="h-5 w-5 text-amber-500" />}
          label="Most Expensive Provider"
          value={PROVIDER_LABELS[mostExpensiveProvider?.[0] ?? "anthropic"] ?? "Anthropic"}
          sub={`$${formatNumber(mostExpensiveProvider?.[1].cost ?? 0)}`}
          accent="amber"
        />
        <SummaryCard
          icon={<Bot className="h-5 w-5 text-violet-500" />}
          label="Most Expensive Agent"
          value={mostExpensiveAgent?.name ?? "N/A"}
          sub={`$${formatNumber(mostExpensiveAgent?.cost ?? 0)}`}
          accent="violet"
        />
      </div>

      {/* Cost Over Time */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-6">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Cost Over Time
        </h2>
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={filteredHistory}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="date"
              tick={{ fill: "#a1a1aa", fontSize: 12 }}
              tickFormatter={(val) => {
                const d = new Date(val);
                return `${d.getMonth() + 1}/${d.getDate()}`;
              }}
              stroke="#27272a"
            />
            <YAxis
              tick={{ fill: "#a1a1aa", fontSize: 12 }}
              tickFormatter={(val) => `$${val}`}
              stroke="#27272a"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: "8px",
                color: "#e4e4e7",
              }}
              formatter={(value: number) => [`$${value.toFixed(2)}`, undefined]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <Legend
              wrapperStyle={{ color: "#a1a1aa" }}
            />
            <Area
              type="monotone"
              dataKey="anthropic"
              stackId="1"
              stroke="#0ea5e9"
              fill="#0ea5e9"
              fillOpacity={0.3}
              name="Anthropic"
            />
            <Area
              type="monotone"
              dataKey="openai"
              stackId="1"
              stroke="#10b981"
              fill="#10b981"
              fillOpacity={0.3}
              name="OpenAI"
            />
            <Area
              type="monotone"
              dataKey="google"
              stackId="1"
              stroke="#f59e0b"
              fill="#f59e0b"
              fillOpacity={0.3}
              name="Google"
            />
            <Area
              type="monotone"
              dataKey="groq"
              stackId="1"
              stroke="#8b5cf6"
              fill="#8b5cf6"
              fillOpacity={0.3}
              name="Groq"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Cost by Provider + Cost by Agent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pie Chart - Cost by Provider */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-6">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Cost by Provider
          </h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={4}
                dataKey="value"
                nameKey="name"
                label={({ name, percent }) =>
                  `${name} ${(percent * 100).toFixed(0)}%`
                }
              >
                {pieData.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px",
                  color: "#e4e4e7",
                }}
                formatter={(value: number) => [`$${value.toFixed(2)}`]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Bar Chart - Cost by Agent */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-6">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">
            Cost by Agent
          </h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={sortedAgentCosts}
              layout="vertical"
              margin={{ left: 20 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#27272a"
                horizontal={false}
              />
              <XAxis
                type="number"
                tick={{ fill: "#a1a1aa", fontSize: 12 }}
                tickFormatter={(val) => `$${val}`}
                stroke="#27272a"
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: "#a1a1aa", fontSize: 12 }}
                width={100}
                stroke="#27272a"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px",
                  color: "#e4e4e7",
                }}
                formatter={(value: number) => [`$${value.toFixed(2)}`, "Cost"]}
              />
              <Bar dataKey="cost" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Provider Cost Table */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-6">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">
          Provider Cost Breakdown
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left py-3 px-4 text-zinc-400 font-medium">
                  Provider
                </th>
                <th className="text-right py-3 px-4 text-zinc-400 font-medium">
                  Requests
                </th>
                <th className="text-right py-3 px-4 text-zinc-400 font-medium">
                  Tokens
                </th>
                <th className="text-right py-3 px-4 text-zinc-400 font-medium">
                  Cost
                </th>
                <th className="text-right py-3 px-4 text-zinc-400 font-medium">
                  Avg Cost/Request
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(providerTotals)
                .sort((a, b) => b[1].cost - a[1].cost)
                .map(([key, data]) => (
                  <tr
                    key={key}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: PROVIDER_COLORS[key] }}
                        />
                        <span className="text-zinc-100 font-medium">
                          {PROVIDER_LABELS[key]}
                        </span>
                      </div>
                    </td>
                    <td className="text-right py-3 px-4 text-zinc-300">
                      {formatNumber(data.requests)}
                    </td>
                    <td className="text-right py-3 px-4 text-zinc-300">
                      {formatNumber(data.tokens)}
                    </td>
                    <td className="text-right py-3 px-4 text-zinc-100 font-medium">
                      ${formatNumber(data.cost)}
                    </td>
                    <td className="text-right py-3 px-4 text-zinc-300">
                      $
                      {data.requests > 0
                        ? (data.cost / data.requests).toFixed(4)
                        : "0.00"}
                    </td>
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-700">
                <td className="py-3 px-4 text-zinc-100 font-semibold">
                  Total
                </td>
                <td className="text-right py-3 px-4 text-zinc-100 font-semibold">
                  {formatNumber(
                    Object.values(providerTotals).reduce(
                      (s, d) => s + d.requests,
                      0
                    )
                  )}
                </td>
                <td className="text-right py-3 px-4 text-zinc-100 font-semibold">
                  {formatNumber(
                    Object.values(providerTotals).reduce(
                      (s, d) => s + d.tokens,
                      0
                    )
                  )}
                </td>
                <td className="text-right py-3 px-4 text-zinc-100 font-semibold">
                  ${formatNumber(totalCost)}
                </td>
                <td className="text-right py-3 px-4 text-zinc-300">-</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 rounded-lg bg-zinc-800">{icon}</div>
        <span className="text-sm text-zinc-400">{label}</span>
      </div>
      <div className="text-xl font-bold text-zinc-100 truncate">{value}</div>
      {sub && <div className="text-sm text-zinc-400 mt-1">{sub}</div>}
    </div>
  );
}
