import { useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ToggleLeft,
  ToggleRight,
  Save,
  RotateCcw,
  Bot,
  Sliders,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface GuardrailRule {
  id: string;
  name: string;
  description: string;
  category: "safety" | "policy" | "quality";
  enabled: boolean;
  mode: "block" | "flag";
  threshold: number;
  appliesTo: string[];
}

const AGENTS = ["All Agents", "Orchestrator", "Research Agent", "Code Assistant", "Data Analyst", "Content Writer"];

const defaultRules: GuardrailRule[] = [
  { id: "toxicity", name: "Toxicity Filter", description: "Block or flag responses containing toxic, hateful, or abusive language", category: "safety", enabled: true, mode: "block", threshold: 0.7, appliesTo: ["All Agents"] },
  { id: "prompt-injection", name: "Prompt Injection Detection", description: "Detect and prevent prompt injection attempts in user input", category: "safety", enabled: true, mode: "block", threshold: 0.8, appliesTo: ["All Agents"] },
  { id: "pii", name: "PII Detection", description: "Flag responses that may contain personal identifiable information (SSN, credit cards, etc.)", category: "policy", enabled: true, mode: "flag", threshold: 0.6, appliesTo: ["All Agents"] },
  { id: "secrets", name: "Secret Leak Prevention", description: "Block responses containing API keys, passwords, or tokens", category: "policy", enabled: true, mode: "block", threshold: 0.9, appliesTo: ["All Agents"] },
  { id: "topic-boundary", name: "Topic Boundaries", description: "Keep agents within their designated domain; flag off-topic responses", category: "policy", enabled: false, mode: "flag", threshold: 0.5, appliesTo: ["Research Agent", "Content Writer"] },
  { id: "hallucination", name: "Hallucination Detection", description: "Flag responses with low factual grounding or unsupported claims", category: "quality", enabled: false, mode: "flag", threshold: 0.6, appliesTo: ["Research Agent"] },
  { id: "code-safety", name: "Code Safety Scanner", description: "Scan generated code for security vulnerabilities (eval, SQL injection, XSS)", category: "safety", enabled: true, mode: "flag", threshold: 0.7, appliesTo: ["Code Assistant"] },
  { id: "cost-guard", name: "Cost Guard", description: "Flag or block requests that would exceed token budget thresholds", category: "policy", enabled: false, mode: "flag", threshold: 0.8, appliesTo: ["All Agents"] },
];

const categoryConfig = {
  safety: { label: "Safety", color: "text-red-400", bg: "bg-red-500/10" },
  policy: { label: "Policy", color: "text-amber-400", bg: "bg-amber-500/10" },
  quality: { label: "Quality", color: "text-sky-400", bg: "bg-sky-500/10" },
};

export function GuardrailsPage() {
  const [rules, setRules] = useState(defaultRules);
  const [saved, setSaved] = useState(defaultRules);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const isDirty = JSON.stringify(rules) !== JSON.stringify(saved);

  const updateRule = (id: string, update: Partial<GuardrailRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...update } : r)));
  };

  const filtered = selectedCategory === "all" ? rules : rules.filter((r) => r.category === selectedCategory);

  const enabledCount = rules.filter((r) => r.enabled).length;
  const blockCount = rules.filter((r) => r.enabled && r.mode === "block").length;
  const flagCount = rules.filter((r) => r.enabled && r.mode === "flag").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Guardrails</h1>
        <p className="text-sm text-zinc-500">Configure input/output safety filters for agent responses</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total Rules", value: rules.length, icon: ShieldCheck, color: "text-sky-400" },
          { label: "Active", value: enabledCount, icon: ShieldAlert, color: "text-emerald-400" },
          { label: "Blocking", value: blockCount, icon: ShieldAlert, color: "text-red-400" },
          { label: "Flagging", value: flagCount, icon: Sliders, color: "text-amber-400" },
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

      {/* Filter */}
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        {["all", "safety", "policy", "quality"].map((cat) => (
          <button key={cat} onClick={() => setSelectedCategory(cat)} className={cn("rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors", selectedCategory === cat ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300")}>
            {cat}
          </button>
        ))}
      </div>

      {/* Rules */}
      <div className="space-y-3">
        {filtered.map((rule) => {
          const cat = categoryConfig[rule.category];
          return (
            <div key={rule.id} className={cn("rounded-xl border bg-zinc-900/50 p-4 transition-all", rule.enabled ? "border-zinc-700" : "border-zinc-800 opacity-60")}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-200">{rule.name}</h3>
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", cat.bg, cat.color)}>{cat.label}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{rule.description}</p>
                </div>
                <button onClick={() => updateRule(rule.id, { enabled: !rule.enabled })} className="shrink-0">
                  {rule.enabled ? (
                    <ToggleRight className="h-6 w-6 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="h-6 w-6 text-zinc-600" />
                  )}
                </button>
              </div>

              {rule.enabled && (
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  {/* Mode */}
                  <div>
                    <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-600">Mode</label>
                    <div className="flex gap-1">
                      {(["block", "flag"] as const).map((m) => (
                        <button key={m} onClick={() => updateRule(rule.id, { mode: m })} className={cn("flex-1 rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors", rule.mode === m ? (m === "block" ? "bg-red-500/10 text-red-400" : "bg-amber-500/10 text-amber-400") : "bg-zinc-800 text-zinc-500 hover:text-zinc-300")}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Threshold */}
                  <div>
                    <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-600">Threshold: {rule.threshold.toFixed(1)}</label>
                    <input
                      type="range"
                      min={0.1}
                      max={1.0}
                      step={0.1}
                      value={rule.threshold}
                      onChange={(e) => updateRule(rule.id, { threshold: parseFloat(e.target.value) })}
                      className="w-full accent-sky-500"
                    />
                    <div className="flex justify-between text-[9px] text-zinc-600">
                      <span>Lenient</span>
                      <span>Strict</span>
                    </div>
                  </div>

                  {/* Agents */}
                  <div>
                    <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-zinc-600">Applies To</label>
                    <div className="flex flex-wrap gap-1">
                      {AGENTS.map((agent) => {
                        const active = rule.appliesTo.includes(agent);
                        return (
                          <button
                            key={agent}
                            onClick={() => {
                              const next = active
                                ? rule.appliesTo.filter((a) => a !== agent)
                                : [...rule.appliesTo, agent];
                              updateRule(rule.id, { appliesTo: next.length ? next : [agent] });
                            }}
                            className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors", active ? "bg-sky-500/10 text-sky-400" : "bg-zinc-800 text-zinc-600 hover:text-zinc-400")}
                          >
                            <Bot className="h-2.5 w-2.5" />
                            {agent}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save bar */}
      {isDirty && (
        <div className="sticky bottom-0 flex items-center justify-between rounded-xl border border-sky-500/30 bg-zinc-900/95 p-3 backdrop-blur-sm">
          <p className="text-xs text-zinc-400">Unsaved guardrail changes</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setRules(saved)} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
              <RotateCcw className="h-3 w-3" />Reset
            </button>
            <button onClick={() => setSaved(rules)} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500">
              <Save className="h-3 w-3" />Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
