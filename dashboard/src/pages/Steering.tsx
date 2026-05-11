import { useState, useRef, useEffect } from "react";
import {
  Navigation,
  Radio,
  Clock,
  MessageSquare,
  Wrench,
  Bot,
  Send,
  Zap,
  Activity,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NodeStatus = "working" | "waiting" | "thinking" | "completed";

interface SteerNudge {
  id: string;
  text: string;
  timestamp: string;
  status: "pending" | "delivered";
}

interface ActivityEvent {
  id: string;
  type: "tool_call" | "tool_result" | "response" | "steer";
  content: string;
  timestamp: string;
  meta?: string;
}

interface LiveSession {
  id: string;
  agentId: string;
  agentName: string;
  model: string;
  status: NodeStatus;
  startedAt: string;
  messageCount: number;
  toolCalls: number;
  tokenCount: number;
  events: ActivityEvent[];
  nudges: SteerNudge[];
}

const now = Date.now();

const mockSessions: LiveSession[] = [
  {
    id: "sess-live-001",
    agentId: "orchestrator",
    agentName: "Orchestrator",
    model: "claude-sonnet-4-20250514",
    status: "working",
    startedAt: new Date(now - 420_000).toISOString(),
    messageCount: 14,
    toolCalls: 8,
    tokenCount: 23_400,
    events: [
      { id: "e1", type: "tool_call", content: "web_search('latest React 19 migration guide')", timestamp: new Date(now - 300_000).toISOString(), meta: "completed in 1.2s" },
      { id: "e2", type: "tool_result", content: "Retrieved 8 results from web_search", timestamp: new Date(now - 298_000).toISOString() },
      { id: "e3", type: "response", content: "Based on the search results, I'll compile a migration checklist covering the key breaking changes in React 19...", timestamp: new Date(now - 280_000).toISOString() },
      { id: "e4", type: "steer", content: "Focus on server components migration specifically, not general React 19 changes", timestamp: new Date(now - 250_000).toISOString() },
      { id: "e5", type: "tool_call", content: "read_url('https://react.dev/blog/react-19-upgrade')", timestamp: new Date(now - 240_000).toISOString(), meta: "completed in 2.4s" },
      { id: "e6", type: "response", content: "Narrowing focus to server components. Here's the updated migration plan for RSC specifically...", timestamp: new Date(now - 200_000).toISOString() },
      { id: "e7", type: "tool_call", content: "search_codebase('use client directive')", timestamp: new Date(now - 60_000).toISOString(), meta: "running..." },
    ],
    nudges: [
      { id: "n1", text: "Focus on server components migration specifically, not general React 19 changes", timestamp: new Date(now - 250_000).toISOString(), status: "delivered" },
    ],
  },
  {
    id: "sess-live-002",
    agentId: "researcher",
    agentName: "Research Agent",
    model: "gpt-4o",
    status: "waiting",
    startedAt: new Date(now - 900_000).toISOString(),
    messageCount: 22,
    toolCalls: 15,
    tokenCount: 45_200,
    events: [
      { id: "e1", type: "tool_call", content: "web_search('transformer architecture improvements 2026')", timestamp: new Date(now - 600_000).toISOString(), meta: "completed in 0.8s" },
      { id: "e2", type: "response", content: "Found several key papers on sparse attention mechanisms and mixture-of-experts routing...", timestamp: new Date(now - 550_000).toISOString() },
      { id: "e3", type: "steer", content: "Include benchmarks and performance numbers, not just qualitative descriptions", timestamp: new Date(now - 500_000).toISOString() },
      { id: "e4", type: "tool_call", content: "web_search('MoE routing benchmark results 2026')", timestamp: new Date(now - 480_000).toISOString(), meta: "completed in 1.1s" },
      { id: "e5", type: "steer", content: "Compare against the DeepSeek-V3 baseline specifically", timestamp: new Date(now - 400_000).toISOString() },
      { id: "e6", type: "tool_call", content: "summarize(article_content)", timestamp: new Date(now - 350_000).toISOString(), meta: "completed in 3.2s" },
      { id: "e7", type: "response", content: "Compilation complete. Adding DeepSeek-V3 comparison table with MMLU, HumanEval, and MATH scores...", timestamp: new Date(now - 120_000).toISOString() },
    ],
    nudges: [
      { id: "n1", text: "Include benchmarks and performance numbers, not just qualitative descriptions", timestamp: new Date(now - 500_000).toISOString(), status: "delivered" },
      { id: "n2", text: "Compare against the DeepSeek-V3 baseline specifically", timestamp: new Date(now - 400_000).toISOString(), status: "delivered" },
    ],
  },
  {
    id: "sess-live-003",
    agentId: "coder",
    agentName: "Code Assistant",
    model: "claude-sonnet-4-20250514",
    status: "thinking",
    startedAt: new Date(now - 180_000).toISOString(),
    messageCount: 6,
    toolCalls: 3,
    tokenCount: 12_800,
    events: [
      { id: "e1", type: "tool_call", content: "read_file('src/auth/middleware.ts')", timestamp: new Date(now - 150_000).toISOString(), meta: "completed in 0.1s" },
      { id: "e2", type: "tool_call", content: "read_file('src/auth/jwt.ts')", timestamp: new Date(now - 140_000).toISOString(), meta: "completed in 0.1s" },
      { id: "e3", type: "response", content: "I see the issue. The JWT verification is not checking token expiry correctly. The `exp` claim is being compared against seconds but Date.now() returns milliseconds...", timestamp: new Date(now - 120_000).toISOString() },
      { id: "e4", type: "tool_call", content: "write_file('src/auth/jwt.ts', ...)", timestamp: new Date(now - 90_000).toISOString(), meta: "completed in 0.2s" },
      { id: "e5", type: "response", content: "Fixed the JWT expiry check. Now running tests to verify the fix doesn't break existing auth flows...", timestamp: new Date(now - 60_000).toISOString() },
    ],
    nudges: [],
  },
  {
    id: "sess-live-004",
    agentId: "data-analyst",
    agentName: "Data Analyst",
    model: "gemini-2.5-flash",
    status: "working",
    startedAt: new Date(now - 600_000).toISOString(),
    messageCount: 10,
    toolCalls: 6,
    tokenCount: 18_900,
    events: [
      { id: "e1", type: "tool_call", content: "sql_query('SELECT date, SUM(revenue) FROM orders GROUP BY date ORDER BY date DESC LIMIT 30')", timestamp: new Date(now - 500_000).toISOString(), meta: "completed in 0.5s" },
      { id: "e2", type: "response", content: "Revenue data retrieved. I see a significant dip on April 15th — down 34% from the prior day...", timestamp: new Date(now - 450_000).toISOString() },
      { id: "e3", type: "tool_call", content: "sql_query('SELECT * FROM incidents WHERE date = 2026-04-15')", timestamp: new Date(now - 400_000).toISOString(), meta: "completed in 0.3s" },
      { id: "e4", type: "tool_call", content: "chart('revenue_trend', data)", timestamp: new Date(now - 200_000).toISOString(), meta: "completed in 1.8s" },
      { id: "e5", type: "response", content: "Chart generated. The revenue dip correlates with a payment gateway outage logged at 14:23 UTC on April 15th...", timestamp: new Date(now - 150_000).toISOString() },
      { id: "e6", type: "tool_call", content: "execute_code('anomaly_detection.py')", timestamp: new Date(now - 30_000).toISOString(), meta: "running..." },
    ],
    nudges: [],
  },
];

const statusConfig: Record<NodeStatus, { label: string; color: string; pulse: boolean }> = {
  working: { label: "Working", color: "bg-emerald-400", pulse: true },
  waiting: { label: "Waiting", color: "bg-amber-400", pulse: false },
  thinking: { label: "Thinking", color: "bg-sky-400", pulse: true },
  completed: { label: "Done", color: "bg-zinc-500", pulse: false },
};

const eventIcons: Record<string, typeof Wrench> = {
  tool_call: Wrench,
  tool_result: Activity,
  response: MessageSquare,
  steer: Navigation,
};

function formatElapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function SteeringPage() {
  const [selectedId, setSelectedId] = useState<string>(mockSessions[0]!.id);
  const [steerInput, setSteerInput] = useState("");
  const [sessions, setSessions] = useState(mockSessions);
  const feedRef = useRef<HTMLDivElement>(null);

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0]!;

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [selected.events.length]);

  const handleSteer = () => {
    if (!steerInput.trim()) return;
    const nudge: SteerNudge = {
      id: `n-${Date.now()}`,
      text: steerInput.trim(),
      timestamp: new Date().toISOString(),
      status: "pending",
    };
    const event: ActivityEvent = {
      id: `e-${Date.now()}`,
      type: "steer",
      content: steerInput.trim(),
      timestamp: new Date().toISOString(),
    };
    setSessions((prev) =>
      prev.map((s) =>
        s.id === selectedId
          ? { ...s, nudges: [...s.nudges, nudge], events: [...s.events, event] }
          : s,
      ),
    );
    setSteerInput("");
  };

  const activeSessions = sessions.filter((s) => s.status !== "completed");
  const totalNudgesToday = sessions.reduce((sum, s) => sum + s.nudges.length, 0);
  const avgDuration =
    sessions.reduce((sum, s) => sum + (Date.now() - new Date(s.startedAt).getTime()), 0) /
    sessions.length;
  const workingCount = sessions.filter((s) => s.status === "working").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">Live Agent Steering</h1>
        <p className="text-sm text-zinc-500">
          Monitor running sessions and inject mid-run guidance
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Active Sessions", value: activeSessions.length, icon: Radio, color: "text-emerald-400" },
          { label: "Nudges Sent Today", value: totalNudgesToday, icon: Navigation, color: "text-violet-400" },
          { label: "Avg Duration", value: `${Math.floor(avgDuration / 60_000)}m`, icon: Clock, color: "text-sky-400" },
          { label: "Agents Working", value: workingCount, icon: Bot, color: "text-amber-400" },
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

      {/* Main content */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Session list */}
        <div className="w-full space-y-2 lg:w-[38%]">
          <h2 className="text-sm font-semibold text-zinc-300">Running Sessions</h2>
          {sessions.map((session) => {
            const sc = statusConfig[session.status];
            const isSelected = session.id === selectedId;
            return (
              <button
                key={session.id}
                onClick={() => setSelectedId(session.id)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-all",
                  isSelected
                    ? "border-sky-500/40 bg-sky-500/5 shadow-[0_0_12px_rgba(14,165,233,0.08)]"
                    : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <div className={cn("h-2 w-2 rounded-full", sc.color)} />
                      {sc.pulse && (
                        <div className={cn("absolute inset-0 animate-ping rounded-full opacity-40", sc.color)} />
                      )}
                    </div>
                    <span className="text-sm font-medium">{session.agentName}</span>
                  </div>
                  <ChevronRight className={cn("h-3.5 w-3.5 text-zinc-600 transition-transform", isSelected && "rotate-90 text-sky-400")} />
                </div>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-500">
                  <span>{session.id.slice(0, 14)}...</span>
                  <span>{formatElapsed(session.startedAt)}</span>
                  <span>{session.messageCount} msgs</span>
                  <span>{session.toolCalls} tools</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", {
                    "bg-emerald-500/10 text-emerald-400": session.status === "working",
                    "bg-amber-500/10 text-amber-400": session.status === "waiting",
                    "bg-sky-500/10 text-sky-400": session.status === "thinking",
                    "bg-zinc-800 text-zinc-500": session.status === "completed",
                  })}>
                    {sc.label}
                  </span>
                  {session.nudges.length > 0 && (
                    <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">
                      {session.nudges.length} nudge{session.nudges.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Live view */}
        <div className="flex w-full flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 lg:w-[62%]">
          {/* Session header */}
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10">
                <Bot className="h-4 w-4 text-sky-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">{selected.agentName}</p>
                <p className="text-[11px] text-zinc-500">{selected.model}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatElapsed(selected.startedAt)}
              </span>
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3" />
                {formatTokens(selected.tokenCount)} tokens
              </span>
            </div>
          </div>

          {/* Activity feed */}
          <div ref={feedRef} className="flex-1 space-y-1 overflow-y-auto p-3" style={{ maxHeight: 420 }}>
            {selected.events.map((event) => {
              const Icon = eventIcons[event.type] ?? Activity;
              const isSteer = event.type === "steer";
              return (
                <div
                  key={event.id}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors",
                    isSteer
                      ? "border border-violet-500/20 bg-violet-500/5"
                      : "hover:bg-zinc-800/30",
                  )}
                >
                  <div className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded",
                    isSteer ? "bg-violet-500/20" : "bg-zinc-800",
                  )}>
                    <Icon className={cn("h-3 w-3", isSteer ? "text-violet-400" : "text-zinc-500")} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-xs leading-relaxed", isSteer ? "font-medium text-violet-300" : "text-zinc-300")}>
                      {isSteer && <span className="mr-1.5 text-violet-500">/steer</span>}
                      {event.content}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-[10px] text-zinc-600">
                        {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      {event.meta && (
                        <span className={cn("text-[10px]", event.meta.includes("running") ? "text-amber-500" : "text-zinc-600")}>
                          {event.meta}
                        </span>
                      )}
                      {isSteer && (
                        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">
                          Delivered after next tool call
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Past nudges */}
          {selected.nudges.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-zinc-800/50 px-3 py-2">
              {selected.nudges.map((nudge) => (
                <span
                  key={nudge.id}
                  className={cn(
                    "max-w-[200px] truncate rounded-full px-2.5 py-0.5 text-[10px]",
                    nudge.status === "delivered"
                      ? "bg-violet-500/10 text-violet-400"
                      : "bg-amber-500/10 text-amber-400",
                  )}
                  title={nudge.text}
                >
                  {nudge.text}
                </span>
              ))}
            </div>
          )}

          {/* Steering input */}
          <div className="border-t border-zinc-800 p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Navigation className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-violet-500" />
                <input
                  value={steerInput}
                  onChange={(e) => setSteerInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSteer()}
                  placeholder="Inject a steering nudge..."
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/20"
                />
              </div>
              <button
                onClick={handleSteer}
                disabled={!steerInput.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
              >
                <Send className="h-3 w-3" />
                Steer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
