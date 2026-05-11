import { useState } from "react";
import {
  Clock,
  Bot,
  Filter,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import { mockAgents } from "@/hooks/use-mock-data";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ActivityBlock {
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  startTime: number; // epoch ms
  duration: number; // ms
  status: "active" | "completed" | "error" | "timeout";
  messageCount: number;
  tokenCount: number;
}

/* ------------------------------------------------------------------ */
/*  Mock timeline data                                                 */
/* ------------------------------------------------------------------ */

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateMockTimelineData(): ActivityBlock[] {
  const rand = seededRandom(42);
  const blocks: ActivityBlock[] = [];
  const now = Date.now();
  const dayStart = now - 24 * 60 * 60 * 1000;

  mockAgents.forEach((agent, agentIdx) => {
    const count = 3 + Math.floor(rand() * 6); // 3-8 blocks
    for (let i = 0; i < count; i++) {
      const offsetMs = rand() * 22 * 60 * 60 * 1000; // within 22h window
      const startTime = dayStart + offsetMs;
      const duration = (5 + rand() * 55) * 60 * 1000; // 5-60 min
      const statusWeights = rand();
      const status: ActivityBlock["status"] =
        statusWeights < 0.55
          ? "completed"
          : statusWeights < 0.75
            ? "active"
            : statusWeights < 0.9
              ? "timeout"
              : "error";

      blocks.push({
        id: `tb-${agentIdx}-${i}`,
        agentId: agent.id,
        agentName: agent.displayName,
        sessionId: `session-${String(agentIdx * 10 + i + 1).padStart(3, "0")}`,
        startTime,
        duration,
        status,
        messageCount: 5 + Math.floor(rand() * 45),
        tokenCount: 1000 + Math.floor(rand() * 49000),
      });
    }
  });

  return blocks;
}

const mockTimelineData = generateMockTimelineData();

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

const STATUS_BAR_COLOR: Record<ActivityBlock["status"], string> = {
  active: "bg-sky-500",
  completed: "bg-emerald-500",
  error: "bg-red-500",
  timeout: "bg-amber-500",
};

const STATUS_BAR_HOVER: Record<ActivityBlock["status"], string> = {
  active: "hover:bg-sky-400",
  completed: "hover:bg-emerald-400",
  error: "hover:bg-red-400",
  timeout: "hover:bg-amber-400",
};

const STATUS_LABEL: Record<ActivityBlock["status"], string> = {
  active: "Active",
  completed: "Completed",
  error: "Error",
  timeout: "Timeout",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ActivityTimelinePage() {
  const [timeRange, setTimeRange] = useState<6 | 12 | 24>(24);
  const [dayOffset, setDayOffset] = useState(0);
  const [selectedBlock, setSelectedBlock] = useState<ActivityBlock | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  /* --- date navigation --- */
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + dayOffset);
  const dateLabel =
    dayOffset === 0
      ? "Today"
      : baseDate.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });

  /* --- time window --- */
  const now = Date.now();
  const windowEnd = now + dayOffset * 86_400_000;
  const windowStart = windowEnd - timeRange * 3_600_000;
  const windowMs = timeRange * 3_600_000;

  /* --- filter blocks --- */
  const visibleBlocks = mockTimelineData.filter((b) => {
    const blockEnd = b.startTime + b.duration;
    const inWindow = blockEnd >= windowStart && b.startTime <= windowEnd;
    const matchesStatus =
      statusFilter === "all" || b.status === statusFilter;
    return inWindow && matchesStatus;
  });

  /* --- unique agents (preserve order) --- */
  const agentOrder = mockAgents.map((a) => ({
    id: a.id,
    name: a.displayName,
  }));

  /* --- time labels --- */
  const labelCount = timeRange <= 6 ? 7 : timeRange <= 12 ? 7 : 13;
  const stepMs = windowMs / (labelCount - 1);
  const timeLabels = Array.from({ length: labelCount }, (_, i) => {
    const t = new Date(windowStart + i * stepMs);
    return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  });

  /* --- summary stats --- */
  const totalSessions = visibleBlocks.length;
  const avgDuration =
    totalSessions > 0
      ? visibleBlocks.reduce((s, b) => s + b.duration, 0) / totalSessions
      : 0;

  const agentSessionCounts: Record<string, number> = {};
  visibleBlocks.forEach((b) => {
    agentSessionCounts[b.agentName] =
      (agentSessionCounts[b.agentName] ?? 0) + 1;
  });
  const busiestAgent =
    Object.entries(agentSessionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "—";

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Activity Timeline
          </h1>
          <p className="text-sm text-zinc-500">
            Gantt-style view of agent sessions over time
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Status filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="error">Error</option>
              <option value="timeout">Timeout</option>
            </select>
          </div>

          {/* Date nav */}
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-1">
            <button
              onClick={() => setDayOffset((d) => d - 1)}
              className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setDayOffset(0)}
              className="min-w-[4.5rem] px-2 py-1.5 text-center text-sm font-medium text-zinc-300 transition-colors hover:text-white"
            >
              {dateLabel}
            </button>
            <button
              onClick={() => setDayOffset((d) => Math.min(d + 1, 0))}
              className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Time range toggle */}
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-900">
            {([6, 12, 24] as const).map((h) => (
              <button
                key={h}
                onClick={() => setTimeRange(h)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  timeRange === h
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ---- Timeline ---- */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
        {/* X-axis labels */}
        <div className="flex border-b border-zinc-800">
          <div className="w-40 shrink-0 border-r border-zinc-800 bg-zinc-900 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Agent
          </div>
          <div className="relative flex-1 bg-zinc-900 px-2 py-2">
            <div className="flex justify-between">
              {timeLabels.map((label, i) => (
                <span
                  key={i}
                  className="text-[10px] text-zinc-600"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Agent rows */}
        {agentOrder.map((agent) => {
          const agentBlocks = visibleBlocks.filter(
            (b) => b.agentId === agent.id,
          );

          return (
            <div
              key={agent.id}
              className="group flex border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/20"
            >
              {/* Agent label */}
              <div className="flex w-40 shrink-0 items-center gap-2 border-r border-zinc-800 px-4 py-3">
                <Bot className="h-3.5 w-3.5 text-zinc-500" />
                <span className="truncate text-xs font-medium text-zinc-300">
                  {agent.name}
                </span>
              </div>

              {/* Bar area */}
              <div className="relative flex-1" style={{ minHeight: "2.75rem" }}>
                {/* Vertical grid lines */}
                {timeLabels.map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 w-px bg-zinc-800/40"
                    style={{
                      left: `${(i / (labelCount - 1)) * 100}%`,
                    }}
                  />
                ))}

                {/* Horizontal center line */}
                <div className="absolute left-0 right-0 top-1/2 h-px bg-zinc-800/30" />

                {/* Activity bars */}
                {agentBlocks.map((block) => {
                  const offsetPct =
                    ((block.startTime - windowStart) / windowMs) * 100;
                  const widthPct = (block.duration / windowMs) * 100;

                  // Clamp to visible area
                  const clampedLeft = Math.max(0, offsetPct);
                  const clampedRight = Math.min(100, offsetPct + widthPct);
                  const clampedWidth = clampedRight - clampedLeft;

                  if (clampedWidth <= 0) return null;

                  return (
                    <button
                      key={block.id}
                      onClick={() =>
                        setSelectedBlock(
                          selectedBlock?.id === block.id ? null : block,
                        )
                      }
                      className={cn(
                        "absolute top-1/2 -translate-y-1/2 h-5 rounded-sm transition-all cursor-pointer",
                        STATUS_BAR_COLOR[block.status],
                        STATUS_BAR_HOVER[block.status],
                        "opacity-80 hover:opacity-100 hover:h-6",
                        selectedBlock?.id === block.id &&
                          "opacity-100 ring-2 ring-white/30 h-6",
                      )}
                      style={{
                        left: `${clampedLeft}%`,
                        width: `${Math.max(clampedWidth, 0.3)}%`,
                      }}
                      title={`${block.agentName} — ${formatDuration(block.duration)}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ---- Detail popover ---- */}
      {selectedBlock && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "h-3 w-3 rounded-sm",
                  STATUS_BAR_COLOR[selectedBlock.status],
                )}
              />
              <div>
                <h3 className="text-sm font-semibold text-zinc-200">
                  {selectedBlock.agentName}
                </h3>
                <p className="font-mono text-[10px] text-zinc-500">
                  {selectedBlock.sessionId}
                </p>
              </div>
            </div>
            <button
              onClick={() => setSelectedBlock(null)}
              className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            >
              <span className="text-xs">Close</span>
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-4">
            <div>
              <span className="text-zinc-600">Status</span>
              <p className="text-zinc-300">{STATUS_LABEL[selectedBlock.status]}</p>
            </div>
            <div>
              <span className="flex items-center gap-1 text-zinc-600">
                <Clock className="h-3 w-3" />
                Duration
              </span>
              <p className="text-zinc-300">
                {formatDuration(selectedBlock.duration)}
              </p>
            </div>
            <div>
              <span className="text-zinc-600">Messages</span>
              <p className="text-zinc-300">{selectedBlock.messageCount}</p>
            </div>
            <div>
              <span className="text-zinc-600">Tokens</span>
              <p className="text-zinc-300">
                {selectedBlock.tokenCount.toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-zinc-600">Started</span>
              <p className="text-zinc-300">
                {new Date(selectedBlock.startTime).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            <div>
              <span className="text-zinc-600">Ended</span>
              <p className="text-zinc-300">
                {new Date(
                  selectedBlock.startTime + selectedBlock.duration,
                ).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---- Legend + Summary ---- */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4">
          {(Object.entries(STATUS_BAR_COLOR) as [ActivityBlock["status"], string][]).map(
            ([status, color]) => (
              <div key={status} className="flex items-center gap-1.5">
                <div className={cn("h-2.5 w-5 rounded-sm", color)} />
                <span className="text-xs text-zinc-400">
                  {STATUS_LABEL[status]}
                </span>
              </div>
            ),
          )}
        </div>

        {/* Summary */}
        <div className="flex items-center gap-6 text-xs text-zinc-400">
          <div>
            <span className="text-zinc-600">Total sessions:</span>{" "}
            <span className="text-zinc-300">{totalSessions}</span>
          </div>
          <div>
            <span className="text-zinc-600">Avg duration:</span>{" "}
            <span className="text-zinc-300">
              {avgDuration > 0 ? formatDuration(avgDuration) : "—"}
            </span>
          </div>
          <div>
            <span className="text-zinc-600">Busiest agent:</span>{" "}
            <span className="text-zinc-300">{busiestAgent}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
