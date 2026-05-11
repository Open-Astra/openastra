import { useState } from "react";
import {
  Bot,
  ChevronRight,
  ChevronLeft,
  Check,
  Cpu,
  Brain,
  Wrench,
  Sparkles,
  Play,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = ["Basics", "Model", "Skills & Tools", "Memory", "Test", "Deploy"];

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", models: [{ id: "claude-opus-4-7", name: "Claude Opus 4.7" }, { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] },
  { id: "openai", name: "OpenAI", models: [{ id: "gpt-5-4", name: "GPT-5.4" }, { id: "gpt-4o", name: "GPT-4o" }] },
  { id: "google", name: "Google", models: [{ id: "gemini-2-5-pro", name: "Gemini 2.5 Pro" }, { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash" }] },
];

const SKILL_CATALOG = [
  { id: "research", label: "Research", description: "Web search and summarization" },
  { id: "coding", label: "Coding", description: "Code generation and review" },
  { id: "writing", label: "Writing", description: "Content drafting and editing" },
  { id: "data-analysis", label: "Data Analysis", description: "SQL, charts, statistics" },
  { id: "fact-checking", label: "Fact Checking", description: "Claim verification" },
  { id: "translation", label: "Translation", description: "Multi-language translation" },
];

const TOOL_CATALOG = [
  { id: "web_search", label: "Web Search" },
  { id: "read_url", label: "Read URL" },
  { id: "read_file", label: "Read File" },
  { id: "write_file", label: "Write File" },
  { id: "execute_code", label: "Execute Code" },
  { id: "sql_query", label: "SQL Query" },
  { id: "search_codebase", label: "Search Codebase" },
  { id: "summarize", label: "Summarize" },
  { id: "chart", label: "Chart Generation" },
];

interface WizardState {
  name: string;
  description: string;
  tier: "free" | "premium";
  provider: string;
  model: string;
  systemPrompt: string;
  skills: string[];
  tools: string[];
  maxCalls: number;
  memoryNamespace: string;
  spawnEnabled: boolean;
  spawnMaxDepth: number;
  testMessage: string;
  testResult: string | null;
  testRunning: boolean;
}

export function AgentWizardPage() {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    name: "", description: "", tier: "premium",
    provider: "anthropic", model: "claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.", skills: [], tools: [],
    maxCalls: 30, memoryNamespace: "", spawnEnabled: false, spawnMaxDepth: 2,
    testMessage: "Hello! What can you do?", testResult: null, testRunning: false,
  });

  const update = (partial: Partial<WizardState>) => setState((prev) => ({ ...prev, ...partial }));

  const canNext = () => {
    if (step === 0) return state.name.trim().length > 0;
    if (step === 1) return state.model.length > 0;
    return true;
  };

  const handleTest = () => {
    update({ testRunning: true, testResult: null });
    setTimeout(() => {
      update({
        testRunning: false,
        testResult: `Hello! I'm ${state.name || "your new agent"}. I'm configured with ${state.skills.length} skills and ${state.tools.length} tools.\n\nI can help you with:\n${state.skills.map((s) => `• ${SKILL_CATALOG.find((sc) => sc.id === s)?.label ?? s}`).join("\n") || "• General assistance"}\n\nI'm running on ${PROVIDERS.flatMap((p) => p.models).find((m) => m.id === state.model)?.name ?? state.model}. How can I help?`,
      });
    }, 1200);
  };

  const currentProvider = PROVIDERS.find((p) => p.id === state.provider);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Create Agent</h1>
        <p className="text-sm text-zinc-500">Step-by-step wizard to configure and deploy a new agent</p>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <button
              onClick={() => i <= step && setStep(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                i === step ? "bg-sky-500/10 text-sky-400" : i < step ? "text-emerald-400" : "text-zinc-600",
              )}
            >
              {i < step ? <Check className="h-3 w-3" /> : <span className="flex h-4 w-4 items-center justify-center rounded-full border text-[10px]">{i + 1}</span>}
              <span className="hidden sm:inline">{s}</span>
            </button>
            {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        {/* Step 0: Basics */}
        {step === 0 && (
          <div className="space-y-4 max-w-lg">
            <h2 className="text-sm font-semibold text-zinc-200">Agent Basics</h2>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Name</label>
              <input value={state.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Research Assistant" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Description</label>
              <textarea value={state.description} onChange={(e) => update({ description: e.target.value })} placeholder="What does this agent do?" rows={2} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Tier</label>
              <div className="flex gap-2">
                {(["free", "premium"] as const).map((t) => (
                  <button key={t} onClick={() => update({ tier: t })} className={cn("flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors", state.tier === t ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500 hover:text-zinc-300")}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Model */}
        {step === 1 && (
          <div className="space-y-4 max-w-lg">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Cpu className="h-4 w-4 text-sky-400" />Model Selection</h2>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Provider</label>
              <div className="flex gap-2">
                {PROVIDERS.map((p) => (
                  <button key={p.id} onClick={() => update({ provider: p.id, model: p.models[0]!.id })} className={cn("flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors", state.provider === p.id ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500 hover:text-zinc-300")}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Model</label>
              <div className="space-y-1">
                {currentProvider?.models.map((m) => (
                  <button key={m.id} onClick={() => update({ model: m.id })} className={cn("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs text-left transition-colors", state.model === m.id ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800")}>
                    {state.model === m.id && <Check className="h-3 w-3" />}
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">System Prompt</label>
              <textarea value={state.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })} rows={4} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none" />
            </div>
          </div>
        )}

        {/* Step 2: Skills & Tools */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Sparkles className="h-4 w-4 text-violet-400" />Skills & Tools</h2>
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-400">Skills</label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SKILL_CATALOG.map((skill) => {
                  const active = state.skills.includes(skill.id);
                  return (
                    <button key={skill.id} onClick={() => update({ skills: active ? state.skills.filter((s) => s !== skill.id) : [...state.skills, skill.id] })} className={cn("rounded-lg border p-3 text-left transition-all", active ? "border-violet-500/30 bg-violet-500/5" : "border-zinc-800 hover:border-zinc-700")}>
                      <div className="flex items-center gap-2">
                        {active && <Check className="h-3 w-3 text-violet-400" />}
                        <span className={cn("text-xs font-medium", active ? "text-violet-300" : "text-zinc-300")}>{skill.label}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-zinc-500">{skill.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-400">Tools</label>
              <div className="flex flex-wrap gap-1.5">
                {TOOL_CATALOG.map((tool) => {
                  const active = state.tools.includes(tool.id);
                  return (
                    <button key={tool.id} onClick={() => update({ tools: active ? state.tools.filter((t) => t !== tool.id) : [...state.tools, tool.id] })} className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors", active ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500 hover:text-zinc-300")}>
                      <Wrench className="h-2.5 w-2.5" />
                      {tool.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Max Tool Calls per Turn</label>
              <input type="number" value={state.maxCalls} onChange={(e) => update({ maxCalls: parseInt(e.target.value) || 0 })} className="w-32 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none" />
            </div>
          </div>
        )}

        {/* Step 3: Memory */}
        {step === 3 && (
          <div className="space-y-4 max-w-lg">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Brain className="h-4 w-4 text-emerald-400" />Memory Configuration</h2>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Memory Namespace</label>
              <input value={state.memoryNamespace} onChange={(e) => update({ memoryNamespace: e.target.value })} placeholder={state.name.toLowerCase().replace(/\s+/g, "-") || "agent-namespace"} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none" />
              <p className="mt-1 text-[10px] text-zinc-600">Isolates this agent's memory from others</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Sub-Agent Spawning</label>
              <div className="flex gap-2">
                <button onClick={() => update({ spawnEnabled: false })} className={cn("flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors", !state.spawnEnabled ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500")}>Disabled</button>
                <button onClick={() => update({ spawnEnabled: true })} className={cn("flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors", state.spawnEnabled ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500")}>Enabled</button>
              </div>
            </div>
            {state.spawnEnabled && (
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Max Spawn Depth</label>
                <input type="number" value={state.spawnMaxDepth} onChange={(e) => update({ spawnMaxDepth: parseInt(e.target.value) || 1 })} min={1} max={5} className="w-32 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none" />
              </div>
            )}
          </div>
        )}

        {/* Step 4: Test */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Play className="h-4 w-4 text-amber-400" />Test Your Agent</h2>
            <div className="max-w-lg">
              <label className="mb-1 block text-xs font-medium text-zinc-400">Test Message</label>
              <div className="flex gap-2">
                <input value={state.testMessage} onChange={(e) => update({ testMessage: e.target.value })} className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none" />
                <button onClick={handleTest} disabled={state.testRunning} className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-40">
                  {state.testRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Test
                </button>
              </div>
            </div>
            {state.testResult && (
              <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-4">
                <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
                  <Bot className="h-3.5 w-3.5 text-sky-400" />
                  {state.name || "Agent"} responded:
                </div>
                <div className="whitespace-pre-wrap text-sm text-zinc-300">{state.testResult}</div>
              </div>
            )}
          </div>
        )}

        {/* Step 5: Deploy */}
        {step === 5 && (
          <div className="space-y-4 max-w-lg">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Bot className="h-4 w-4 text-emerald-400" />Review & Deploy</h2>
            <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-xs">
              {[
                { label: "Name", value: state.name },
                { label: "Tier", value: state.tier },
                { label: "Model", value: PROVIDERS.flatMap((p) => p.models).find((m) => m.id === state.model)?.name ?? state.model },
                { label: "Skills", value: state.skills.map((s) => SKILL_CATALOG.find((sc) => sc.id === s)?.label ?? s).join(", ") || "None" },
                { label: "Tools", value: `${state.tools.length} tools` },
                { label: "Max Calls", value: String(state.maxCalls) },
                { label: "Memory", value: state.memoryNamespace || state.name.toLowerCase().replace(/\s+/g, "-") },
                { label: "Spawning", value: state.spawnEnabled ? `Enabled (depth ${state.spawnMaxDepth})` : "Disabled" },
              ].map((row) => (
                <div key={row.label} className="flex justify-between"><span className="text-zinc-500">{row.label}</span><span className="text-zinc-200">{row.value}</span></div>
              ))}
            </div>
            <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500">
              <Bot className="h-4 w-4" />
              Deploy Agent
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-4 py-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 disabled:opacity-30">
          <ChevronLeft className="h-3.5 w-3.5" />Back
        </button>
        {step < STEPS.length - 1 && (
          <button onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} disabled={!canNext()} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40">
            Next<ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
