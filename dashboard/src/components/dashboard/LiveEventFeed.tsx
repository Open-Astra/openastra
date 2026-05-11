import {
  Bot,
  Wrench,
  ArrowRightLeft,
  Brain,
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  MessageSquare,
} from "lucide-react";
import { useEventStore } from "@/stores/events";
import { mockEvents } from "@/hooks/use-mock-data";
import { formatRelativeTime, cn } from "@/lib/utils";
import type { LiveEvent } from "@/types/api";

const eventConfig: Record<
  string,
  { icon: typeof Bot; color: string; bg: string }
> = {
  agent_start: { icon: Bot, color: "text-sky-400", bg: "bg-sky-500/10" },
  agent_complete: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
  tool_call: { icon: Wrench, color: "text-amber-400", bg: "bg-amber-500/10" },
  tool_result: { icon: Wrench, color: "text-amber-300", bg: "bg-amber-500/10" },
  handoff: { icon: ArrowRightLeft, color: "text-violet-400", bg: "bg-violet-500/10" },
  error: { icon: AlertTriangle, color: "text-red-400", bg: "bg-red-500/10" },
  memory_write: { icon: Brain, color: "text-pink-400", bg: "bg-pink-500/10" },
  spawn: { icon: GitBranch, color: "text-cyan-400", bg: "bg-cyan-500/10" },
  message: { icon: MessageSquare, color: "text-zinc-400", bg: "bg-zinc-500/10" },
};

function EventItem({ event }: { event: LiveEvent }) {
  const config = eventConfig[event.type] ?? eventConfig.message!;
  const Icon = config.icon;

  return (
    <div className="flex gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-800/30">
      <div className={cn("mt-0.5 rounded-lg p-1.5", config.bg)}>
        <Icon className={cn("h-3.5 w-3.5", config.color)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {event.agentName && (
            <span className="text-xs font-semibold text-zinc-200">
              {event.agentName}
            </span>
          )}
          <span className="text-[10px] text-zinc-600">
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">{event.content}</p>
      </div>
    </div>
  );
}

export function LiveEventFeed() {
  const storeEvents = useEventStore((s) => s.events);
  const events = storeEvents.length > 0 ? storeEvents : mockEvents;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-300">Live Activity</h2>
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <span className="text-[10px] text-zinc-500">Live</span>
        </div>
      </div>
      <div className="max-h-[480px] overflow-y-auto p-1">
        {events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}
        {events.length === 0 && (
          <p className="py-8 text-center text-xs text-zinc-600">
            No events yet. Activity will appear here in real time.
          </p>
        )}
      </div>
    </div>
  );
}
