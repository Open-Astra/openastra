import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Search,
  Play,
  Trash2,
  Plus,
  Clock,
  Repeat,
  CalendarCheck,
  Timer,
  Bot,
  ChevronDown,
  X,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn, formatRelativeTime } from "@/lib/utils";
import { mockScheduledTasks, mockAgents } from "@/hooks/use-mock-data";

function describeCron(expr: string): string {
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [minute, hour, dom, , dow] = parts;

  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")} UTC`;

  if (dom === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${time}`;
  if (dom === "*" && dow === "0") return `Sundays at ${time}`;
  if (dom === "*" && dow === "1") return `Mondays at ${time}`;
  if (dom === "1" && dow === "*") return `1st of month at ${time}`;
  return `${expr} (${time})`;
}

export function SchedulesPage() {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const queryClient = useQueryClient();

  const { data: tasks } = useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: () => api.scheduledTasks.list().catch(() => mockScheduledTasks),
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list().catch(() => mockAgents),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => api.scheduledTasks.run(id),
    onSuccess: () => {
      toast.success("Task triggered successfully");
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
    onError: () => toast.error("Failed to trigger task"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.scheduledTasks.delete(id),
    onSuccess: () => {
      toast.success("Task deleted");
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
    onError: () => toast.error("Failed to delete task"),
  });

  const taskList = tasks ?? mockScheduledTasks;
  const agentList = agents ?? mockAgents;

  const filtered = taskList.filter((t) => {
    const matchesSearch =
      t.prompt.toLowerCase().includes(search.toLowerCase()) ||
      (t.agentName?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
      t.agentId.toLowerCase().includes(search.toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "enabled" && t.enabled) ||
      (filter === "disabled" && !t.enabled);
    return matchesSearch && matchesFilter;
  });

  const enabledCount = taskList.filter((t) => t.enabled).length;
  const recurringCount = taskList.filter((t) => t.cronExpression).length;
  const oneShotCount = taskList.filter((t) => t.runAt && !t.cronExpression).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Scheduled Tasks</h1>
          <p className="text-sm text-zinc-500">
            {enabledCount} active, {taskList.length} total
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
        >
          <Plus className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <CalendarClock className="h-3.5 w-3.5" />
            Total Tasks
          </div>
          <p className="mt-1 text-2xl font-bold">{taskList.length}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Repeat className="h-3.5 w-3.5" />
            Recurring
          </div>
          <p className="mt-1 text-2xl font-bold">{recurringCount}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Timer className="h-3.5 w-3.5" />
            One-shot
          </div>
          <p className="mt-1 text-2xl font-bold">{oneShotCount}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <CalendarCheck className="h-3.5 w-3.5" />
            Total Runs
          </div>
          <p className="mt-1 text-2xl font-bold">
            {taskList.reduce((sum, t) => sum + t.runCount, 0)}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <div className="flex rounded-lg border border-zinc-800">
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                filter === f
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-3">
        {filtered.length > 0 ? (
          filtered.map((task) => (
            <div
              key={task.id}
              className={cn(
                "rounded-xl border bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700",
                task.enabled ? "border-zinc-800" : "border-zinc-800/50 opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {/* Agent + schedule info */}
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
                      <Bot className="h-3.5 w-3.5 text-zinc-500" />
                      {task.agentName ?? task.agentId}
                    </span>
                    <StatusBadge
                      status={task.enabled ? "active" : "offline"}
                    />
                    {task.cronExpression ? (
                      <span className="flex items-center gap-1 rounded-md bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">
                        <Repeat className="h-2.5 w-2.5" />
                        {describeCron(task.cronExpression)}
                      </span>
                    ) : task.runAt ? (
                      <span className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                        <Timer className="h-2.5 w-2.5" />
                        One-shot
                      </span>
                    ) : null}
                    {task.maxRuns != null && (
                      <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        max {task.maxRuns} runs
                      </span>
                    )}
                  </div>

                  {/* Prompt */}
                  <p className="mb-3 text-sm leading-relaxed text-zinc-400">
                    {task.prompt}
                  </p>

                  {/* Metadata row */}
                  <div className="flex flex-wrap items-center gap-4 text-[10px] text-zinc-600">
                    {task.cronExpression && (
                      <span className="font-mono">
                        cron: {task.cronExpression}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Play className="h-2.5 w-2.5" />
                      {task.runCount} runs
                    </span>
                    {task.lastRunAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        Last: {formatRelativeTime(task.lastRunAt)}
                      </span>
                    )}
                    {task.nextRunAt && task.enabled && (
                      <span className="flex items-center gap-1 text-sky-500">
                        <CalendarClock className="h-2.5 w-2.5" />
                        Next: {formatRelativeTime(task.nextRunAt)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => runMutation.mutate(task.id)}
                    disabled={runMutation.isPending}
                    title="Run now"
                    className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-30"
                  >
                    {runMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Delete this scheduled task?")) {
                        deleteMutation.mutate(task.id);
                      }
                    }}
                    title="Delete"
                    className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="No scheduled tasks"
            description="Create a scheduled task to run agents on a cron schedule or at a specific time."
            action={
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
              >
                <Plus className="h-3.5 w-3.5" />
                New Task
              </button>
            }
          />
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateTaskModal
          agents={agentList}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

function CreateTaskModal({
  agents,
  onClose,
}: {
  agents: { id: string; displayName: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [scheduleType, setScheduleType] = useState<"cron" | "once">("cron");
  const [cronExpression, setCronExpression] = useState("0 9 * * *");
  const [runAt, setRunAt] = useState("");
  const [maxRuns, setMaxRuns] = useState("");
  const [error, setError] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      api.scheduledTasks.create({
        agentId,
        prompt,
        ...(scheduleType === "cron"
          ? { cronExpression }
          : { runAt: new Date(runAt).toISOString() }),
        ...(maxRuns ? { maxRuns: parseInt(maxRuns, 10) } : {}),
      }),
    onSuccess: () => {
      toast.success("Scheduled task created");
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create task");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!prompt.trim()) {
      setError("Prompt is required");
      return;
    }
    if (scheduleType === "once" && !runAt) {
      setError("Run-at time is required for one-shot tasks");
      return;
    }
    createMutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 w-full max-w-lg space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">New Scheduled Task</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Agent */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Agent
          </label>
          <div className="relative">
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          </div>
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="The message to send to the agent when this task runs..."
            className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
        </div>

        {/* Schedule type */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Schedule
          </label>
          <div className="mb-2 flex rounded-lg border border-zinc-800">
            <button
              type="button"
              onClick={() => setScheduleType("cron")}
              className={cn(
                "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                scheduleType === "cron"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Repeat className="mr-1 inline h-3 w-3" />
              Recurring (Cron)
            </button>
            <button
              type="button"
              onClick={() => setScheduleType("once")}
              className={cn(
                "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                scheduleType === "once"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Timer className="mr-1 inline h-3 w-3" />
              One-shot
            </button>
          </div>
          {scheduleType === "cron" ? (
            <div>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-zinc-600">
                Format: minute hour day-of-month month day-of-week (e.g. "0 9 *
                * 1-5" = weekdays at 9am UTC)
              </p>
            </div>
          ) : (
            <input
              type="datetime-local"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            />
          )}
        </div>

        {/* Max runs */}
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            Max Runs{" "}
            <span className="text-zinc-600">(optional, blank = unlimited)</span>
          </label>
          <input
            type="number"
            min="1"
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
            placeholder="Unlimited"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
          >
            {createMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Create Task
          </button>
        </div>
      </form>
    </div>
  );
}
