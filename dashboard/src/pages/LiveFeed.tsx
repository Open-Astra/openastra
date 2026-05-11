import { useState, useEffect, useRef } from "react";
import {
  Radio,
  Bot,
  Wrench,
  MessageSquare,
  AlertCircle,
  Brain,
  GitFork,
  Pause,
  Play,
  Filter,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEventStore } from "@/stores/events";
import { mockEvents } from "@/hooks/use-mock-data";
import type { LiveEvent } from "@/types/api";

const typeConfig: Record<string, { icon: typeof Bot; color: string; bg: string; label: string }> = {
  agent_start: { icon: Bot, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Start" },
  agent_complete: { icon: Bot, color: "text-sky-400", bg: "bg-sky-500/10", label: "Complete" },
  tool_call: { icon: Wrench, color: "text-amber-400", bg: "bg-amber-500/10", label: "Tool Call" },
  tool_result: { icon: Wrench, color: "text-zinc-400", bg: "bg-zinc-800", label: "Tool Result" },
  handoff: { icon: GitFork, color: "text-violet-400", bg: "bg-violet-500/10", label: "Handoff" },
  error: { icon: AlertCircle, color: "text-red-400", bg: "bg-red-500/10", label: "Error" },
  memory_write: { icon: Brain, color: "text-sky-400", bg: "bg-sky-500/10", label: "Memory" },
  spawn: { icon: GitFork, color: "text-violet-400", bg: "bg-violet-500/10", label: "Spawn" },
  message: { icon: MessageSquare, color: "text-zinc-300", bg: "bg-zinc-800", label: "Message" },
};

function generateLiveEvent(index: number): LiveEvent {
  const types: LiveEvent["type"][] = ["agent_start", "tool_call", "tool_result", "agent_complete", "handoff", "memory_write", "error", "spawn", "message"];
  const agents = ["Orchestrator", "Research Agent", "Code Assistant", "Data Analyst", "Content Writer"];
  const contents: Record<string, string[]> = {
    agent_start: ["Started new session for user request", "Resuming paused session", "Activated for scheduled task"],
    tool_call: ["web_search('multi-agent benchmarks 2026')", "read_file('src/index.ts')", "execute_code('analysis.py')", "sql_query('SELECT * FROM metrics')", "summarize(document)"],
    tool_result: ["Retrieved 8 search results", "File read: 142 lines", "Code executed: 0 errors", "Query returned 23 rows", "Summary generated: 340 tokens"],
    agent_complete: ["Completed research task", "Finished code review", "Analysis report generated", "Email drafted and sent"],
    handoff: ["Delegated research to Research Agent", "Handed off code review to Code Assistant", "Transferred data analysis task"],
    memory_write: ["Stored: user prefers TypeScript", "Updated procedural memory: deploy workflow", "Saved entity: new API endpoint"],
    error: ["Rate limit exceeded on Groq", "Timeout on web_search after 30s", "Connection refused: Ollama not running"],
    spawn: ["Spawned Fact Checker sub-agent", "Created Test Runner for verification", "Spawned Chart Generator"],
    message: ["User sent a follow-up question", "Response delivered via Telegram", "Cron job triggered prompt"],
  };
  const type = types[index % types.length]!;
  const agent = agents[index % agents.length]!;
  const msgs = contents[type]!;
  return {
    id: `live-${Date.now()}-${index}`,
    type,
    agentName: agent,
    content: msgs[index % msgs.length]!,
    timestamp: new Date().toISOString(),
  };
}

export function LiveFeedPage() {
  const storeEvents = useEventStore((s) => s.events);
  const [localEvents, setLocalEvents] = useState<LiveEvent[]>(() => [...mockEvents].reverse());
  const [paused, setPaused] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const feedRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    if (storeEvents.length > 0) {
      setLocalEvents((prev) => [...storeEvents.slice(-50).reverse(), ...prev].slice(0, 200));
    }
  }, [storeEvents]);

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      counterRef.current++;
      const evt = generateLiveEvent(counterRef.current);
      setLocalEvents((prev) => [evt, ...prev].slice(0, 200));
    }, 2000 + Math.random() * 3000);
    return () => clearInterval(interval);
  }, [paused]);

  useEffect(() => {
    if (feedRef.current && !paused) {
      feedRef.current.scrollTop = 0;
    }
  }, [localEvents.length, paused]);

  const filtered = typeFilter === "all" ? localEvents : localEvents.filter((e) => e.type === typeFilter);

  const errorCount = localEvents.filter((e) => e.type === "error").length;
  const toolCallCount = localEvents.filter((e) => e.type === "tool_call").length;
  const uniqueAgents = new Set(localEvents.map((e) => e.agentName).filter(Boolean)).size;

  const types = ["all", "agent_start", "tool_call", "error", "handoff", "spawn", "memory_write"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Live Feed</h1>
          <p className="text-sm text-zinc-500">Real-time event stream across all agents</p>
        </div>
        <button
          onClick={() => setPaused(!paused)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
            paused ? "border-amber-500/30 bg-amber-500/10 text-amber-400" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
          )}
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {paused ? "Paused" : "Live"}
          {!paused && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" /><span className="inline-flex h-2 w-2 rounded-full bg-emerald-400" /></span>}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Events", value: localEvents.length, icon: Radio, color: "text-sky-400" },
          { label: "Tool Calls", value: toolCallCount, icon: Wrench, color: "text-amber-400" },
          { label: "Errors", value: errorCount, icon: AlertCircle, color: "text-red-400" },
          { label: "Active Agents", value: uniqueAgents, icon: Bot, color: "text-emerald-400" },
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

      {/* Filters */}
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        <Filter className="ml-2 h-3 w-3 text-zinc-600" />
        {types.map((t) => {
          const conf = t !== "all" ? typeConfig[t] : null;
          return (
            <button key={t} onClick={() => setTypeFilter(t)} className={cn("rounded-md px-2 py-1 text-[11px] font-medium transition-colors", typeFilter === t ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300")}>
              {t === "all" ? "All" : conf?.label ?? t}
            </button>
          );
        })}
      </div>

      {/* Feed */}
      <div ref={feedRef} className="space-y-1 rounded-xl border border-zinc-800 bg-zinc-900/30 p-3" style={{ maxHeight: 600, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-600">No events matching filter</div>
        ) : (
          filtered.map((event) => {
            const conf = typeConfig[event.type] ?? typeConfig.message!;
            const Icon = conf.icon;
            return (
              <div key={event.id} className={cn("flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-800/30", event.type === "error" && "border border-red-500/10 bg-red-500/5")}>
                <div className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", conf.bg)}>
                  <Icon className={cn("h-3 w-3", conf.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {event.agentName && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-200">
                        <Zap className="h-2.5 w-2.5 text-zinc-500" />
                        {event.agentName}
                      </span>
                    )}
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", conf.bg, conf.color)}>
                      {conf.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-400">{event.content}</p>
                </div>
                <span className="shrink-0 text-[10px] text-zinc-600">
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
