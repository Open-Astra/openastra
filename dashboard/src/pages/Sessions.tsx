import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  History,
  Search,
  Filter,
  Clock,
  Zap,
  MessageSquare,
  Bot,
  User,
  Wrench,
  ChevronRight,
  ChevronDown,
  Loader2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableRowSkeleton } from "@/components/ui/Skeleton";
import {
  cn,
  formatNumber,
  formatDuration,
  formatRelativeTime,
} from "@/lib/utils";
import { mockSessions, getMockMessages } from "@/hooks/use-mock-data";
import type { Message, Session } from "@/types/api";

export function SessionsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions.list({ limit: 50 }).catch(() => mockSessions),
    refetchInterval: 10_000,
  });

  const sessionList = sessions ?? mockSessions;

  const filtered = sessionList.filter((s) => {
    const matchesSearch =
      s.id.toLowerCase().includes(search.toLowerCase()) ||
      (s.agentName?.toLowerCase().includes(search.toLowerCase()) ?? false);
    const matchesStatus =
      statusFilter === "all" || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const detail = selectedSession
    ? sessionList.find((s) => s.id === selectedSession)
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Sessions & History
          </h1>
          <p className="text-sm text-zinc-500">
            {sessionList.filter((s) => s.status === "active").length} active,{" "}
            {sessionList.length} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
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
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Table */}
        <div className={cn("lg:col-span-2", detail && "lg:col-span-1")}>
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            {/* Table header */}
            <div className={cn(
              "flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500",
            )}>
              <span className="w-28">Session ID</span>
              <span className="flex-1">Agent</span>
              {!detail && (
                <>
                  <span className="w-20 text-center">Messages</span>
                  <span className="w-20 text-center">Inferences</span>
                  <span className="w-24 text-right">Duration</span>
                </>
              )}
              <span className="w-20 text-center">Status</span>
            </div>

            {/* Rows */}
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRowSkeleton key={i} cols={detail ? 3 : 6} />
              ))
            ) : filtered.length > 0 ? (
              filtered.map((session) => (
                <button
                  key={session.id}
                  onClick={() => setSelectedSession(
                    selectedSession === session.id ? null : session.id,
                  )}
                  className={cn(
                    "flex w-full items-center gap-4 border-b border-zinc-800/50 px-4 py-2.5 text-left text-xs transition-colors hover:bg-zinc-800/30",
                    selectedSession === session.id && "bg-zinc-800/40 border-l-2 border-l-sky-500",
                  )}
                >
                  <span className="w-28 truncate font-mono text-zinc-400">
                    {session.id.slice(0, 12)}
                  </span>
                  <span className="flex-1 truncate text-zinc-200">
                    {session.agentName ?? session.agentId}
                  </span>
                  {!detail && (
                    <>
                      <span className="w-20 text-center text-zinc-400">
                        {session.messageCount}
                      </span>
                      <span className="w-20 text-center text-zinc-400">
                        {session.inferenceCount}
                      </span>
                      <span className="w-24 text-right text-zinc-500">
                        {session.duration
                          ? formatDuration(session.duration)
                          : "—"}
                      </span>
                    </>
                  )}
                  <span className="flex w-20 justify-center">
                    <StatusBadge status={session.status} />
                  </span>
                </button>
              ))
            ) : (
              <EmptyState
                icon={History}
                title="No sessions found"
                description="No sessions match your filters."
              />
            )}
          </div>
        </div>

        {/* Detail + Conversation panel */}
        {detail && (
          <div className="lg:col-span-2">
            <SessionDetailPanel
              session={detail}
              onClose={() => setSelectedSession(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDetailPanel({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const [metaExpanded, setMetaExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: messages, isLoading } = useQuery({
    queryKey: ["session-messages", session.id],
    queryFn: () =>
      api.sessions.messages(session.id).catch(() => getMockMessages(session.id)),
  });

  const messageList = messages ?? [];

  useEffect(() => {
    if (messageList.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageList.length]);

  return (
    <div className="flex h-[calc(100vh-14rem)] flex-col rounded-xl border border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <Bot className="h-4 w-4 text-sky-400" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">
              {session.agentName ?? session.agentId}
            </h3>
            <p className="text-[10px] font-mono text-zinc-500">{session.id}</p>
          </div>
          <StatusBadge status={session.status} />
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Collapsible metadata */}
      <button
        onClick={() => setMetaExpanded(!metaExpanded)}
        className="flex items-center gap-2 border-b border-zinc-800/50 px-4 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800/30"
      >
        {metaExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="font-medium uppercase tracking-wider">
          Session Info
        </span>
        <span className="text-zinc-600">
          {formatRelativeTime(session.createdAt)} · {session.messageCount} msgs
          · {formatNumber(session.tokenCount)} tokens
        </span>
      </button>

      {metaExpanded && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-zinc-800/50 px-4 py-3 text-xs sm:grid-cols-4">
          <div>
            <span className="text-zinc-600">Started</span>
            <p className="text-zinc-300">
              {formatRelativeTime(session.createdAt)}
            </p>
          </div>
          <div>
            <span className="text-zinc-600">Last Active</span>
            <p className="text-zinc-300">
              {formatRelativeTime(session.lastActiveAt)}
            </p>
          </div>
          <div>
            <span className="flex items-center gap-1 text-zinc-600">
              <MessageSquare className="h-3 w-3" />
              Messages
            </span>
            <p className="text-zinc-300">{session.messageCount}</p>
          </div>
          <div>
            <span className="flex items-center gap-1 text-zinc-600">
              <Zap className="h-3 w-3" />
              Inferences
            </span>
            <p className="text-zinc-300">{session.inferenceCount}</p>
          </div>
          <div>
            <span className="flex items-center gap-1 text-zinc-600">
              <Clock className="h-3 w-3" />
              Duration
            </span>
            <p className="text-zinc-300">
              {session.duration ? formatDuration(session.duration) : "—"}
            </p>
          </div>
          <div>
            <span className="text-zinc-600">Tokens</span>
            <p className="text-zinc-300">
              {formatNumber(session.tokenCount)}
            </p>
          </div>
          <div>
            <span className="text-zinc-600">Surface</span>
            <p className="text-zinc-300">{session.surface}</p>
          </div>
        </div>
      )}

      {/* Conversation log */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
          </div>
        ) : messageList.length > 0 ? (
          <div className="space-y-1 p-4">
            {messageList.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                agentName={session.agentName ?? session.agentId}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-xs text-zinc-600">
            No messages in this session
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  agentName,
}: {
  message: Message;
  agentName: string;
}) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";

  if (isSystem) {
    return (
      <div className="py-1 text-center text-[10px] text-zinc-600 italic">
        {message.content}
      </div>
    );
  }

  if (isTool) {
    return (
      <div className="mx-8 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-500">
        {message.content.slice(0, 200)}
        {message.content.length > 200 && "..."}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg px-3 py-3",
        isUser ? "bg-zinc-800/30" : "",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
          isUser ? "bg-zinc-700" : "bg-sky-500/10",
        )}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5 text-zinc-300" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-sky-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="text-[10px] font-medium text-zinc-500">
            {isUser ? "You" : agentName}
          </span>
          <span className="text-[10px] text-zinc-700">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
          {message.content}
        </div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setToolsExpanded(!toolsExpanded)}
              className="flex items-center gap-1 text-[10px] text-zinc-600 transition-colors hover:text-zinc-400"
            >
              {toolsExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <Wrench className="h-3 w-3" />
              {message.toolCalls.length} tool call
              {message.toolCalls.length > 1 ? "s" : ""}
            </button>
            {toolsExpanded && (
              <div className="mt-1 space-y-1">
                {message.toolCalls.map((tc) => (
                  <div
                    key={tc.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400">
                      <Wrench className="h-3 w-3" />
                      <span className="font-mono">{tc.name}</span>
                    </div>
                    <pre className="mt-1 overflow-x-auto text-[10px] text-zinc-600">
                      {tc.arguments}
                    </pre>
                    {tc.result && (
                      <pre className="mt-1 overflow-x-auto border-t border-zinc-800 pt-1 text-[10px] text-emerald-600">
                        {tc.result}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
