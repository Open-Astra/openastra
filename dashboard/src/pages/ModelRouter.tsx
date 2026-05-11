import { useState } from "react";
import {
  Cpu,
  DollarSign,
  Timer,
  TrendingDown,
  ChevronDown,
  Check,
  Save,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelOption {
  id: string;
  name: string;
  provider: string;
  inputCostPer1K: number;
  outputCostPer1K: number;
  latencyP50: number;
  quality: "premium" | "recommended" | "budget" | "local";
  online: boolean;
}

interface TaskConfig {
  id: string;
  name: string;
  description: string;
  modelId: string;
  estimatedCallsPerDay: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

const models: ModelOption[] = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "Anthropic", inputCostPer1K: 0.015, outputCostPer1K: 0.075, latencyP50: 1200, quality: "premium", online: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", inputCostPer1K: 0.003, outputCostPer1K: 0.015, latencyP50: 520, quality: "recommended", online: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Anthropic", inputCostPer1K: 0.0008, outputCostPer1K: 0.004, latencyP50: 180, quality: "budget", online: true },
  { id: "gpt-5-4", name: "GPT-5.4", provider: "OpenAI", inputCostPer1K: 0.01, outputCostPer1K: 0.03, latencyP50: 800, quality: "premium", online: true },
  { id: "gpt-5-4-mini", name: "GPT-5.4 Mini", provider: "OpenAI", inputCostPer1K: 0.0004, outputCostPer1K: 0.0016, latencyP50: 220, quality: "budget", online: true },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", inputCostPer1K: 0.005, outputCostPer1K: 0.015, latencyP50: 450, quality: "recommended", online: true },
  { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", provider: "Google", inputCostPer1K: 0.007, outputCostPer1K: 0.021, latencyP50: 600, quality: "recommended", online: true },
  { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", provider: "Google", inputCostPer1K: 0.0003, outputCostPer1K: 0.001, latencyP50: 150, quality: "budget", online: true },
  { id: "llama-3-3-70b", name: "Llama 3.3 70B", provider: "Ollama", inputCostPer1K: 0, outputCostPer1K: 0, latencyP50: 350, quality: "local", online: false },
];

const defaultTasks: TaskConfig[] = [
  { id: "primary", name: "Primary Reasoning", description: "Main agent LLM calls", modelId: "claude-sonnet-4-6", estimatedCallsPerDay: 200, avgInputTokens: 2000, avgOutputTokens: 800 },
  { id: "compression", name: "Compression", description: "Context window summarization", modelId: "claude-haiku-4-5", estimatedCallsPerDay: 80, avgInputTokens: 4000, avgOutputTokens: 500 },
  { id: "vision", name: "Vision", description: "Image analysis and OCR", modelId: "gpt-4o", estimatedCallsPerDay: 15, avgInputTokens: 1500, avgOutputTokens: 300 },
  { id: "session-search", name: "Session Search", description: "Cross-session memory recall", modelId: "claude-haiku-4-5", estimatedCallsPerDay: 50, avgInputTokens: 800, avgOutputTokens: 200 },
  { id: "title-gen", name: "Title Generation", description: "Auto-naming sessions", modelId: "gemini-2-5-flash", estimatedCallsPerDay: 40, avgInputTokens: 500, avgOutputTokens: 20 },
  { id: "embedding", name: "Embedding", description: "Vector embedding for RAG", modelId: "gemini-2-5-flash", estimatedCallsPerDay: 120, avgInputTokens: 600, avgOutputTokens: 0 },
  { id: "guardrails", name: "Guardrails", description: "Input/output safety checks", modelId: "claude-haiku-4-5", estimatedCallsPerDay: 200, avgInputTokens: 500, avgOutputTokens: 50 },
  { id: "code-exec", name: "Code Execution", description: "Code generation and analysis", modelId: "claude-sonnet-4-6", estimatedCallsPerDay: 60, avgInputTokens: 3000, avgOutputTokens: 1200 },
];

const presets = [
  { name: "Quality First", description: "Opus for reasoning, Sonnet for everything else", assignments: { primary: "claude-opus-4-7", compression: "claude-sonnet-4-6", vision: "gpt-4o", "session-search": "claude-sonnet-4-6", "title-gen": "claude-sonnet-4-6", embedding: "claude-sonnet-4-6", guardrails: "claude-sonnet-4-6", "code-exec": "claude-opus-4-7" } },
  { name: "Balanced", description: "Sonnet for reasoning, Flash/Haiku for support", assignments: { primary: "claude-sonnet-4-6", compression: "claude-haiku-4-5", vision: "gpt-4o", "session-search": "claude-haiku-4-5", "title-gen": "gemini-2-5-flash", embedding: "gemini-2-5-flash", guardrails: "claude-haiku-4-5", "code-exec": "claude-sonnet-4-6" } },
  { name: "Budget", description: "Flash/Haiku everywhere", assignments: { primary: "claude-haiku-4-5", compression: "gemini-2-5-flash", vision: "gpt-5-4-mini", "session-search": "gemini-2-5-flash", "title-gen": "gemini-2-5-flash", embedding: "gemini-2-5-flash", guardrails: "gemini-2-5-flash", "code-exec": "claude-haiku-4-5" } },
  { name: "Local First", description: "Ollama where possible, cloud fallback", assignments: { primary: "llama-3-3-70b", compression: "llama-3-3-70b", vision: "gpt-4o", "session-search": "llama-3-3-70b", "title-gen": "llama-3-3-70b", embedding: "llama-3-3-70b", guardrails: "claude-haiku-4-5", "code-exec": "llama-3-3-70b" } },
];

type RoutingMode = "auto" | "manual" | "budget";

const qualityBadge: Record<string, { label: string; color: string }> = {
  premium: { label: "Premium", color: "bg-violet-500/10 text-violet-400" },
  recommended: { label: "Recommended", color: "bg-emerald-500/10 text-emerald-400" },
  budget: { label: "Budget", color: "bg-amber-500/10 text-amber-400" },
  local: { label: "Local", color: "bg-sky-500/10 text-sky-400" },
};

function calcMonthlyCost(tasks: TaskConfig[]): number {
  return tasks.reduce((sum, task) => {
    const model = models.find((m) => m.id === task.modelId);
    if (!model) return sum;
    const dailyCost =
      task.estimatedCallsPerDay *
      ((task.avgInputTokens / 1000) * model.inputCostPer1K +
        (task.avgOutputTokens / 1000) * model.outputCostPer1K);
    return sum + dailyCost * 30;
  }, 0);
}

function calcAvgLatency(tasks: TaskConfig[]): number {
  const latencies = tasks.map((t) => models.find((m) => m.id === t.modelId)?.latencyP50 ?? 0);
  return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
}

export function ModelRouterPage() {
  const [mode, setMode] = useState<RoutingMode>("manual");
  const [tasks, setTasks] = useState<TaskConfig[]>(defaultTasks);
  const [savedTasks, setSavedTasks] = useState<TaskConfig[]>(defaultTasks);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);

  const isDirty = JSON.stringify(tasks) !== JSON.stringify(savedTasks);
  const monthlyCost = calcMonthlyCost(tasks);
  const avgLatency = calcAvgLatency(tasks);

  const allPremium = defaultTasks.map((t) => ({ ...t, modelId: "claude-opus-4-7" }));
  const allBudgetTasks = defaultTasks.map((t) => ({ ...t, modelId: "gemini-2-5-flash" }));
  const premiumCost = calcMonthlyCost(allPremium);
  const savings = premiumCost > 0 ? Math.round(((premiumCost - monthlyCost) / premiumCost) * 100) : 0;

  const configuredModels = new Set(tasks.map((t) => t.modelId)).size;

  const updateModel = (taskId: string, modelId: string) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, modelId } : t)));
    setOpenDropdown(null);
  };

  const applyPreset = (assignments: Record<string, string>) => {
    setTasks((prev) => prev.map((t) => ({ ...t, modelId: (assignments as Record<string, string>)[t.id] ?? t.modelId })));
  };

  const grouped = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Model Router</h1>
        <p className="text-sm text-zinc-500">Configure per-task model assignments for optimal cost and performance</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Models Configured", value: configuredModels, icon: Cpu, color: "text-sky-400" },
          { label: "Est. Monthly Cost", value: `$${monthlyCost.toFixed(2)}`, icon: DollarSign, color: "text-amber-400" },
          { label: "Avg Latency", value: `${avgLatency}ms`, icon: Timer, color: "text-violet-400" },
          { label: "Savings vs Premium", value: `${savings}%`, icon: TrendingDown, color: "text-emerald-400" },
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

      {/* Routing mode */}
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        {(["auto", "manual", "budget"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded-md px-4 py-1.5 text-xs font-medium capitalize transition-colors",
              mode === m ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Task router grid */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tasks.map((task) => {
          const model = models.find((m) => m.id === task.modelId);
          const badge = model ? qualityBadge[model.quality] : null;
          const isOpen = openDropdown === task.id;
          const taskDailyCost = model
            ? task.estimatedCallsPerDay *
              ((task.avgInputTokens / 1000) * model.inputCostPer1K +
                (task.avgOutputTokens / 1000) * model.outputCostPer1K)
            : 0;

          return (
            <div key={task.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-200">{task.name}</h3>
                  {model?.online ? (
                    <div className="h-2 w-2 rounded-full bg-emerald-400" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-red-400" />
                  )}
                </div>
                <p className="text-[11px] text-zinc-500">{task.description}</p>
              </div>

              {/* Model selector */}
              <div className="relative">
                <button
                  onClick={() => setOpenDropdown(isOpen ? null : task.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 transition-colors hover:border-zinc-600"
                >
                  <span>{model?.name ?? "Select model"}</span>
                  <ChevronDown className={cn("h-3 w-3 text-zinc-500 transition-transform", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl">
                    {Object.entries(grouped).map(([provider, provModels]) => (
                      <div key={provider}>
                        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">{provider}</p>
                        {provModels.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => updateModel(task.id, m.id)}
                            className={cn(
                              "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs transition-colors",
                              m.id === task.modelId
                                ? "bg-sky-500/10 text-sky-400"
                                : "text-zinc-300 hover:bg-zinc-800",
                            )}
                          >
                            <span className="flex items-center gap-1.5">
                              {m.id === task.modelId && <Check className="h-3 w-3" />}
                              {m.name}
                            </span>
                            <span className="text-[10px] text-zinc-600">{m.latencyP50}ms</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Stats */}
              {model && (
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Cost/1K in</span>
                    <span className="text-zinc-300">${model.inputCostPer1K.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Cost/1K out</span>
                    <span className="text-zinc-300">${model.outputCostPer1K.toFixed(4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">P50 Latency</span>
                    <span className="text-zinc-300">{model.latencyP50}ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Daily cost est.</span>
                    <span className="font-medium text-zinc-200">${taskDailyCost.toFixed(3)}</span>
                  </div>
                  {badge && (
                    <div className="pt-1">
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", badge.color)}>{badge.label}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Cost comparison table */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Cost Comparison (Monthly)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="pb-2 text-left font-medium">Task</th>
                <th className="pb-2 text-left font-medium">Current Model</th>
                <th className="pb-2 text-right font-medium">Current</th>
                <th className="pb-2 text-right font-medium">All Opus</th>
                <th className="pb-2 text-right font-medium">All Flash</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const curModel = models.find((m) => m.id === task.modelId);
                const opusModel = models.find((m) => m.id === "claude-opus-4-7")!;
                const flashModel = models.find((m) => m.id === "gemini-2-5-flash")!;
                const calcCost = (m: ModelOption) =>
                  task.estimatedCallsPerDay * 30 *
                  ((task.avgInputTokens / 1000) * m.inputCostPer1K +
                    (task.avgOutputTokens / 1000) * m.outputCostPer1K);
                const curCost = curModel ? calcCost(curModel) : 0;
                const opusCost = calcCost(opusModel);
                const flashCost = calcCost(flashModel);
                return (
                  <tr key={task.id} className="border-b border-zinc-800/50">
                    <td className="py-2 font-medium text-zinc-300">{task.name}</td>
                    <td className="py-2 text-zinc-400">{curModel?.name}</td>
                    <td className="py-2 text-right text-zinc-200">${curCost.toFixed(2)}</td>
                    <td className="py-2 text-right text-zinc-400">${opusCost.toFixed(2)}</td>
                    <td className="py-2 text-right text-zinc-400">${flashCost.toFixed(2)}</td>
                  </tr>
                );
              })}
              <tr className="font-semibold">
                <td className="pt-2 text-zinc-200">Total</td>
                <td />
                <td className="pt-2 text-right text-zinc-100">${monthlyCost.toFixed(2)}</td>
                <td className="pt-2 text-right text-zinc-400">${premiumCost.toFixed(2)}</td>
                <td className="pt-2 text-right text-zinc-400">${calcMonthlyCost(allBudgetTasks).toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Presets */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
        <button
          onClick={() => setPresetsOpen(!presetsOpen)}
          className="flex w-full items-center justify-between p-4"
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <Sparkles className="h-4 w-4 text-violet-400" />
            Preset Configurations
          </h2>
          <ChevronDown className={cn("h-4 w-4 text-zinc-500 transition-transform", presetsOpen && "rotate-180")} />
        </button>
        {presetsOpen && (
          <div className="grid gap-2 border-t border-zinc-800 p-4 sm:grid-cols-2 lg:grid-cols-4">
            {presets.map((preset) => {
              const presetTasks = defaultTasks.map((t) => ({ ...t, modelId: (preset.assignments as Record<string, string>)[t.id] ?? t.modelId }));
              const presetCost = calcMonthlyCost(presetTasks);
              return (
                <div key={preset.name} className="rounded-lg border border-zinc-700 bg-zinc-800/30 p-3">
                  <h3 className="text-xs font-semibold text-zinc-200">{preset.name}</h3>
                  <p className="mt-0.5 text-[10px] text-zinc-500">{preset.description}</p>
                  <p className="mt-2 text-sm font-bold text-zinc-100">${presetCost.toFixed(2)}<span className="text-[10px] font-normal text-zinc-500">/mo</span></p>
                  <button
                    onClick={() => applyPreset(preset.assignments)}
                    className="mt-2 w-full rounded-lg bg-sky-600/80 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-sky-500"
                  >
                    Apply
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Save bar */}
      {isDirty && (
        <div className="sticky bottom-0 flex items-center justify-between rounded-xl border border-sky-500/30 bg-zinc-900/95 p-3 backdrop-blur-sm">
          <p className="text-xs text-zinc-400">You have unsaved changes</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTasks(savedTasks)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
            <button
              onClick={() => setSavedTasks(tasks)}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
            >
              <Save className="h-3 w-3" />
              Save Configuration
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
