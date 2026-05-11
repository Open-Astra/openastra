import { useState } from "react";
import { Flame, Zap, DollarSign, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;
const now = Date.now();

function generateHeatmapData(days: number): { date: string; tokens: number; cost: number }[] {
  const data: { date: string; tokens: number; cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const base = isWeekend ? 20_000 : 80_000;
    const variance = Math.random() * 60_000;
    const spike = Math.random() > 0.92 ? 120_000 : 0;
    const tokens = Math.round(base + variance + spike);
    data.push({
      date: d.toISOString().split("T")[0]!,
      tokens,
      cost: tokens * 0.000008,
    });
  }
  return data;
}

const heatmapData = generateHeatmapData(90);

const INTENSITY_COLORS = [
  "bg-zinc-800/50",
  "bg-emerald-900/40",
  "bg-emerald-800/50",
  "bg-emerald-700/60",
  "bg-emerald-600/70",
  "bg-emerald-500/80",
];

function getIntensity(tokens: number, max: number): number {
  if (tokens === 0) return 0;
  const ratio = tokens / max;
  if (ratio < 0.15) return 1;
  if (ratio < 0.3) return 2;
  if (ratio < 0.5) return 3;
  if (ratio < 0.75) return 4;
  return 5;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

export function TokenHeatmapPage() {
  const [range, setRange] = useState<90 | 60 | 30>(90);
  const [hoveredDay, setHoveredDay] = useState<{ date: string; tokens: number; cost: number } | null>(null);

  const data = heatmapData.slice(-range);
  const maxTokens = Math.max(...data.map((d) => d.tokens));
  const totalTokens = data.reduce((s, d) => s + d.tokens, 0);
  const totalCost = data.reduce((s, d) => s + d.cost, 0);
  const avgDaily = Math.round(totalTokens / data.length);
  const peakDay = data.reduce((a, b) => (b.tokens > a.tokens ? b : a), data[0]!);

  const startDate = new Date(data[0]!.date);
  const startDay = startDate.getDay();

  const weeks: (typeof data[0] | null)[][] = [];
  let currentWeek: (typeof data[0] | null)[] = [];

  for (let i = 0; i < startDay; i++) currentWeek.push(null);
  for (const day of data) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  const monthLabels: { label: string; weekIdx: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstDay = week.find((d) => d !== null);
    if (firstDay) {
      const m = new Date(firstDay.date).getMonth();
      if (m !== lastMonth) {
        monthLabels.push({ label: MONTHS[m]!, weekIdx: wi });
        lastMonth = m;
      }
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Token Usage Heatmap</h1>
        <p className="text-sm text-zinc-500">Daily token consumption intensity over time</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total Tokens", value: `${(totalTokens / 1_000_000).toFixed(1)}M`, icon: Zap, color: "text-sky-400" },
          { label: "Total Cost", value: `$${totalCost.toFixed(2)}`, icon: DollarSign, color: "text-emerald-400" },
          { label: "Daily Average", value: `${(avgDaily / 1_000).toFixed(0)}K`, icon: TrendingUp, color: "text-violet-400" },
          { label: "Peak Day", value: `${(peakDay.tokens / 1_000).toFixed(0)}K`, icon: Flame, color: "text-amber-400" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center gap-2">
              <stat.icon className={cn("h-4 w-4", stat.color)} />
              <span className="text-xs text-zinc-500">{stat.label}</span>
            </div>
            <p className="mt-1 text-2xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Range selector */}
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        {([30, 60, 90] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              range === r ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {r}d
          </button>
        ))}
      </div>

      {/* Heatmap */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        {/* Hover tooltip */}
        {hoveredDay && (
          <div className="mb-3 flex items-center gap-4 text-xs">
            <span className="font-medium text-zinc-200">{new Date(hoveredDay.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</span>
            <span className="text-zinc-400">{(hoveredDay.tokens / 1_000).toFixed(1)}K tokens</span>
            <span className="text-zinc-400">${hoveredDay.cost.toFixed(3)}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <div className="inline-flex flex-col gap-0">
            {/* Month labels */}
            <div className="flex" style={{ marginLeft: 32 }}>
              {monthLabels.map((ml) => (
                <div
                  key={`${ml.label}-${ml.weekIdx}`}
                  className="text-[10px] text-zinc-500"
                  style={{ position: "relative", left: ml.weekIdx * 14 }}
                >
                  {ml.label}
                </div>
              ))}
            </div>

            <div className="mt-1 flex gap-0">
              {/* Day labels */}
              <div className="flex flex-col gap-[2px] pr-2">
                {DAYS.map((d, i) => (
                  <div key={i} className="flex h-[12px] items-center text-[9px] text-zinc-600" style={{ width: 24 }}>
                    {d}
                  </div>
                ))}
              </div>

              {/* Grid */}
              <div className="flex gap-[2px]">
                {weeks.map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-[2px]">
                    {week.map((day, di) => (
                      <div
                        key={`${wi}-${di}`}
                        className={cn(
                          "h-[12px] w-[12px] rounded-sm transition-all",
                          day
                            ? INTENSITY_COLORS[getIntensity(day.tokens, maxTokens)]
                            : "bg-transparent",
                          day && "cursor-pointer hover:ring-1 hover:ring-zinc-500",
                        )}
                        onMouseEnter={() => day && setHoveredDay(day)}
                        onMouseLeave={() => setHoveredDay(null)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-4 flex items-center gap-2 text-[10px] text-zinc-500">
          <span>Less</span>
          {INTENSITY_COLORS.map((color, i) => (
            <div key={i} className={cn("h-[12px] w-[12px] rounded-sm", color)} />
          ))}
          <span>More</span>
        </div>
      </div>

      {/* Daily breakdown table */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Top Usage Days</h2>
        <div className="space-y-1">
          {[...data].sort((a, b) => b.tokens - a.tokens).slice(0, 10).map((day) => (
            <div key={day.date} className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-xs hover:bg-zinc-800/30">
              <span className="w-24 text-zinc-400">{new Date(day.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              <div className="flex-1">
                <div className="h-2 rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-emerald-500/60" style={{ width: `${(day.tokens / maxTokens) * 100}%` }} />
                </div>
              </div>
              <span className="w-16 text-right font-medium text-zinc-200">{(day.tokens / 1_000).toFixed(0)}K</span>
              <span className="w-16 text-right text-zinc-500">${day.cost.toFixed(3)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
