import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Send,
  Bot,
  User,
  Wrench,
  Download,
  ChevronDown,
  Loader2,
  Zap,
  Slash,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { mockAgents } from "@/hooks/use-mock-data";
import type { Message } from "@/types/api";

interface ChatMessage extends Message {
  pending?: boolean;
}

interface SlashCommand {
  name: string;
  description: string;
  action: () => void;
}

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("orchestrator");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamTokens, setStreamTokens] = useState(0);
  const [streamStartTime, setStreamStartTime] = useState<number | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedSlashIdx, setSelectedSlashIdx] = useState(0);
  const fastMode = useAppStore((s) => s.fastMode);
  const toggleFastMode = useAppStore((s) => s.toggleFastMode);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list().catch(() => mockAgents),
  });

  const agentList = agents ?? mockAgents;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Streaming token counter
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setStreamTokens((t) => t + Math.floor(Math.random() * 8) + 2);
    }, 100);
    return () => clearInterval(interval);
  }, [isStreaming]);

  const exportChat = () => {
    const text = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${selectedAgent}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const slashCommands: SlashCommand[] = useMemo(() => [
    {
      name: "/clear",
      description: "Clear chat history",
      action: () => {
        setMessages([]);
        toast.success("Chat cleared");
      },
    },
    {
      name: "/export",
      description: "Export chat as text file",
      action: () => {
        if (messages.length === 0) {
          toast.error("No messages to export");
          return;
        }
        exportChat();
        toast.success("Chat exported");
      },
    },
    {
      name: "/fast",
      description: `Toggle fast mode (currently ${fastMode ? "ON" : "OFF"})`,
      action: () => {
        toggleFastMode();
        toast.success(`Fast mode ${!fastMode ? "enabled" : "disabled"}`);
      },
    },
    ...agentList.map((agent) => ({
      name: `/agent ${agent.id}`,
      description: `Switch to ${agent.displayName}`,
      action: () => {
        setSelectedAgent(agent.id);
        toast.success(`Switched to ${agent.displayName}`);
      },
    })),
  ], [fastMode, toggleFastMode, agentList, messages.length]);

  const filteredCommands = slashCommands.filter((cmd) =>
    cmd.name.toLowerCase().includes(slashFilter.toLowerCase()),
  );

  const handleInputChange = (value: string) => {
    setInput(value);
    if (value.startsWith("/") && !value.includes("\n")) {
      setShowSlashMenu(true);
      setSlashFilter(value);
      setSelectedSlashIdx(0);
    } else {
      setShowSlashMenu(false);
    }
  };

  const executeSlashCommand = (cmd: SlashCommand) => {
    cmd.action();
    setInput("");
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    // Check for slash commands
    if (input.startsWith("/")) {
      const match = slashCommands.find(
        (cmd) => input.trim().toLowerCase() === cmd.name.toLowerCase(),
      );
      if (match) {
        executeSlashCommand(match);
        return;
      }
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setShowSlashMenu(false);
    setIsStreaming(true);
    setStreamTokens(0);
    setStreamStartTime(Date.now());

    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      pending: true,
    };

    setMessages((prev) => [...prev, assistantMessage]);

    try {
      for await (const chunk of api.chat.sendStream(selectedAgent, userMessage.content)) {
        if (chunk.content) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, content: m.content + chunk.content, pending: false }
                : m,
            ),
          );
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessage.id
            ? {
                ...m,
                content: `I'm the ${agentList.find((a) => a.id === selectedAgent)?.displayName ?? "Agent"}. The backend isn't connected right now, but this is where my response would stream in real-time. Try connecting to your OpenAstra API at \`/api/chat/stream\` to enable live chat.`,
                pending: false,
              }
            : m,
        ),
      );
    } finally {
      setIsStreaming(false);
      setStreamStartTime(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        executeSlashCommand(filteredCommands[selectedSlashIdx]!);
        return;
      }
      if (e.key === "Escape") {
        setShowSlashMenu(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const streamElapsed = streamStartTime ? ((Date.now() - streamStartTime) / 1000).toFixed(1) : "0.0";

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Chat</h1>
          <p className="text-sm text-zinc-500">
            Talk directly to your agents
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Agent selector */}
          <div className="relative">
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-3 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            >
              {agentList.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          </div>
          <button
            onClick={toggleFastMode}
            title={fastMode ? "Fast mode ON" : "Fast mode OFF"}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all",
              fastMode
                ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400",
            )}
          >
            <Zap className={cn("h-3.5 w-3.5", fastMode && "fill-amber-400")} />
            {fastMode ? "Fast" : "Normal"}
          </button>
          <button
            onClick={exportChat}
            disabled={messages.length === 0}
            className="rounded-lg border border-zinc-800 p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Streaming Indicator Bar */}
      {isStreaming && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-4 py-2">
          <div className="relative flex h-5 w-5 items-center justify-center">
            <span className="absolute h-full w-full animate-ping rounded-full bg-sky-400/30" />
            <Activity className="relative h-3.5 w-3.5 text-sky-400" />
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="font-medium text-sky-300">
              {agentList.find((a) => a.id === selectedAgent)?.displayName} is responding...
            </span>
            <span className="flex items-center gap-1 text-zinc-400">
              <Zap className="h-3 w-3" />
              {formatNumber(streamTokens)} tokens
            </span>
            <span className="text-zinc-500">{streamElapsed}s</span>
            {fastMode && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                FAST
              </span>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/30">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 rounded-xl bg-zinc-800/50 p-4">
              <Bot className="h-8 w-8 text-zinc-500" />
            </div>
            <h3 className="mb-1 text-sm font-semibold text-zinc-300">
              Start a conversation
            </h3>
            <p className="max-w-sm text-xs text-zinc-500">
              Send a message to{" "}
              {agentList.find((a) => a.id === selectedAgent)?.displayName ??
                "the agent"}{" "}
              to begin. Type <kbd className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px]">/</kbd> for commands.
            </p>
            {fastMode && (
              <div className="mt-3 flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[10px] font-medium text-amber-400">
                <Zap className="h-3 w-3 fill-amber-400" />
                Fast mode enabled
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1 p-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex gap-3 rounded-lg px-3 py-3",
                  msg.role === "user" ? "bg-zinc-800/30" : "",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    msg.role === "user"
                      ? "bg-zinc-700"
                      : "bg-sky-500/10",
                  )}
                >
                  {msg.role === "user" ? (
                    <User className="h-3.5 w-3.5 text-zinc-300" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 text-sky-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-[10px] font-medium text-zinc-500">
                    {msg.role === "user"
                      ? "You"
                      : agentList.find((a) => a.id === selectedAgent)
                          ?.displayName ?? "Agent"}
                  </p>
                  {msg.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                  ) : (
                    <div className="text-sm leading-relaxed text-zinc-200 whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  )}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {msg.toolCalls.map((tc) => (
                        <div
                          key={tc.id}
                          className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-500"
                        >
                          <Wrench className="h-3 w-3" />
                          <span className="font-mono">{tc.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="relative mt-3">
        {/* Slash command menu */}
        {showSlashMenu && filteredCommands.length > 0 && (
          <div className="absolute bottom-full mb-2 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl">
            <div className="mb-1 px-2 py-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                <Slash className="mr-1 inline h-3 w-3" />
                Commands
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  onClick={() => executeSlashCommand(cmd)}
                  onMouseEnter={() => setSelectedSlashIdx(idx)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    idx === selectedSlashIdx
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:bg-zinc-800/50",
                  )}
                >
                  <span className="font-mono text-xs">{cmd.name}</span>
                  <span className="text-[10px] text-zinc-600">{cmd.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message or / for commands... (Enter to send)"
              rows={1}
              className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 pr-12 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/50 focus:outline-none focus:ring-1 focus:ring-sky-500/20"
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition-colors hover:bg-sky-500 disabled:opacity-30 disabled:hover:bg-sky-600"
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
