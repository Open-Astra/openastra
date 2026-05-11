import { useState } from "react";
import {
  Play,
  Copy,
  RotateCcw,
  ChevronDown,
  Check,
  Zap,
  Clock,
  DollarSign,
  ArrowLeftRight,
  Loader2,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelDef {
  id: string;
  name: string;
  provider: string;
  inputCostPer1K: number;
  outputCostPer1K: number;
}

interface RunResult {
  output: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cost: number;
}

const MODELS: ModelDef[] = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "Anthropic", inputCostPer1K: 0.015, outputCostPer1K: 0.075 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", inputCostPer1K: 0.003, outputCostPer1K: 0.015 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Anthropic", inputCostPer1K: 0.0008, outputCostPer1K: 0.004 },
  { id: "gpt-5-4", name: "GPT-5.4", provider: "OpenAI", inputCostPer1K: 0.01, outputCostPer1K: 0.03 },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI", inputCostPer1K: 0.005, outputCostPer1K: 0.015 },
  { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", provider: "Google", inputCostPer1K: 0.007, outputCostPer1K: 0.021 },
  { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", provider: "Google", inputCostPer1K: 0.0003, outputCostPer1K: 0.001 },
];

const SAMPLE_PROMPTS = [
  { label: "Code Review", system: "You are a senior code reviewer. Analyze the code for bugs, security issues, and style problems. Be concise.", user: "Review this function:\n\nfunction parseUserInput(raw) {\n  const data = JSON.parse(raw);\n  return eval(data.expression);\n}" },
  { label: "Summarization", system: "You are a research assistant. Summarize the provided text in 2-3 bullet points, preserving key data.", user: "The Q1 2026 report shows revenue of $4.2M, up 23% YoY. Customer churn decreased to 3.1% from 4.8%. The enterprise segment grew 45% driven by three new Fortune 500 clients. Operating costs rose 12% primarily due to GPU infrastructure scaling." },
  { label: "Classification", system: "Classify the user's message into one of: [bug_report, feature_request, question, praise, complaint]. Respond with just the label.", user: "The export button doesn't work when I have more than 50 items selected. It just shows a spinner forever." },
];

const mockOutputs: Record<string, string> = {
  "claude-opus-4-7": "**Critical Security Vulnerability Found**\n\n1. **`eval()` injection** (Critical): `eval(data.expression)` allows arbitrary code execution. An attacker can inject any JavaScript via the `expression` field.\n2. **No input validation**: `JSON.parse(raw)` will throw on invalid JSON with no error handling.\n3. **No type checking**: `data.expression` is not validated to be a string.\n\n**Fix**: Remove `eval()` entirely. Use a safe expression parser like `mathjs` or validate against an allowlist of operations.",
  "claude-sonnet-4-6": "**Issues found:**\n\n1. **Critical**: `eval(data.expression)` is a code injection vulnerability. Never use `eval()` on user input.\n2. **Error handling**: No try/catch around `JSON.parse()` — will throw on malformed input.\n3. **Missing validation**: No schema validation on parsed data.\n\nReplace `eval()` with a safe alternative.",
  "claude-haiku-4-5": "Security issue: `eval()` on user input allows code injection. Remove it. Add try/catch for JSON.parse. Validate input schema.",
  "gpt-5-4": "**Code Review Results**\n\n- **CRITICAL**: `eval(data.expression)` — Remote Code Execution vulnerability. Attacker-controlled input flows directly into `eval()`. Remove immediately.\n- **HIGH**: No error handling on `JSON.parse(raw)` — unhandled exception on invalid JSON.\n- **MEDIUM**: No input type validation — `raw` parameter is untyped.\n\n**Recommendation**: Use `Function()` constructor with sandboxing, or better yet, a purpose-built expression evaluator.",
  "gpt-4o": "Two issues:\n1. `eval()` on user input = RCE vulnerability. Use a safe parser instead.\n2. `JSON.parse()` without try/catch. Wrap in error handling.\n\nBoth are high-severity. Fix before deploying.",
  "gemini-2-5-pro": "**Security Review:**\n\n| Issue | Severity | Line |\n|-------|----------|------|\n| `eval()` injection | Critical | 3 |\n| Unhandled JSON parse | High | 2 |\n| No input validation | Medium | 1 |\n\nThe `eval()` call is the most dangerous — it allows arbitrary code execution from user-supplied data. Replace with a sandboxed expression evaluator.",
  "gemini-2-5-flash": "Critical: eval() on user input (RCE). Remove eval, add try-catch for JSON.parse, validate input types.",
};

function simulateResult(modelId: string, inputLen: number): RunResult {
  const model = MODELS.find((m) => m.id === modelId)!;
  const output = mockOutputs[modelId] ?? "Analysis complete. No major issues found.";
  const outputTokens = Math.round(output.length / 4);
  const inputTokens = Math.round(inputLen / 4);
  const latencyMs = modelId.includes("haiku") || modelId.includes("flash") ? 180 + Math.random() * 100 : modelId.includes("opus") || modelId.includes("5-4") ? 1200 + Math.random() * 400 : 500 + Math.random() * 200;
  const cost = (inputTokens / 1000) * model.inputCostPer1K + (outputTokens / 1000) * model.outputCostPer1K;
  return { output, model: model.name, inputTokens, outputTokens, latencyMs: Math.round(latencyMs), cost };
}

function ModelDropdown({ value, onChange, label }: { value: string; onChange: (id: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const selected = MODELS.find((m) => m.id === value);
  const grouped = MODELS.reduce<Record<string, ModelDef[]>>((acc, m) => { (acc[m.provider] ??= []).push(m); return acc; }, {});

  return (
    <div className="relative">
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">{label}</label>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-600">
        <span>{selected?.name ?? "Select"}</span>
        <ChevronDown className={cn("h-3 w-3 text-zinc-500 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl">
          {Object.entries(grouped).map(([prov, ms]) => (
            <div key={prov}>
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">{prov}</p>
              {ms.map((m) => (
                <button key={m.id} onClick={() => { onChange(m.id); setOpen(false); }} className={cn("flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors", m.id === value ? "bg-sky-500/10 text-sky-400" : "text-zinc-300 hover:bg-zinc-800")}>
                  {m.id === value && <Check className="h-3 w-3" />}
                  {m.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaygroundPage() {
  const [systemPrompt, setSystemPrompt] = useState(SAMPLE_PROMPTS[0]!.system);
  const [userMessage, setUserMessage] = useState(SAMPLE_PROMPTS[0]!.user);
  const [modelA, setModelA] = useState("claude-sonnet-4-6");
  const [modelB, setModelB] = useState("gpt-4o");
  const [compareMode, setCompareMode] = useState(false);
  const [resultA, setResultA] = useState<RunResult | null>(null);
  const [resultB, setResultB] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<"a" | "b" | null>(null);

  const handleRun = () => {
    setRunning(true);
    const inputLen = systemPrompt.length + userMessage.length;
    setTimeout(() => {
      setResultA(simulateResult(modelA, inputLen));
      if (compareMode) setResultB(simulateResult(modelB, inputLen));
      setRunning(false);
    }, 800);
  };

  const handleCopy = (text: string, side: "a" | "b") => {
    navigator.clipboard.writeText(text);
    setCopied(side);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleReset = () => {
    setSystemPrompt("");
    setUserMessage("");
    setResultA(null);
    setResultB(null);
  };

  const loadSample = (idx: number) => {
    const s = SAMPLE_PROMPTS[idx]!;
    setSystemPrompt(s.system);
    setUserMessage(s.user);
    setResultA(null);
    setResultB(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Prompt Playground</h1>
          <p className="text-sm text-zinc-500">Test prompts, compare models, iterate without affecting production</p>
        </div>
        <button
          onClick={() => { setCompareMode(!compareMode); setResultB(null); }}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
            compareMode ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : "border-zinc-800 text-zinc-500 hover:text-zinc-300",
          )}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
          Compare Mode
        </button>
      </div>

      {/* Sample prompts */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Load sample:</span>
        {SAMPLE_PROMPTS.map((s, i) => (
          <button key={s.label} onClick={() => loadSample(i)} className="rounded-lg border border-zinc-800 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200">
            {s.label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/20"
            placeholder="You are a helpful assistant..."
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">User Message</label>
          <textarea
            value={userMessage}
            onChange={(e) => setUserMessage(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/20"
            placeholder="Enter your message..."
          />
        </div>
      </div>

      {/* Model selectors + run */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-52">
          <ModelDropdown value={modelA} onChange={setModelA} label={compareMode ? "Model A" : "Model"} />
        </div>
        {compareMode && (
          <div className="w-52">
            <ModelDropdown value={modelB} onChange={setModelB} label="Model B" />
          </div>
        )}
        <button
          onClick={handleRun}
          disabled={running || !userMessage.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-5 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </button>
        <button onClick={handleReset} className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300">
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      {/* Results */}
      {(resultA || running) && (
        <div className={cn("grid gap-4", compareMode ? "lg:grid-cols-2" : "lg:grid-cols-1")}>
          {/* Result A */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Bot className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-xs font-semibold">{MODELS.find((m) => m.id === modelA)?.name}</span>
              </div>
              {resultA && (
                <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{resultA.latencyMs}ms</span>
                  <span className="flex items-center gap-1"><Zap className="h-3 w-3" />{resultA.inputTokens + resultA.outputTokens} tok</span>
                  <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />${resultA.cost.toFixed(4)}</span>
                  <button onClick={() => handleCopy(resultA.output, "a")} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-800">
                    {copied === "a" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
              )}
            </div>
            <div className="p-4">
              {running && !resultA ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Generating...</div>
              ) : resultA ? (
                <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">{resultA.output}</div>
              ) : null}
            </div>
          </div>

          {/* Result B */}
          {compareMode && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Bot className="h-3.5 w-3.5 text-violet-400" />
                  <span className="text-xs font-semibold">{MODELS.find((m) => m.id === modelB)?.name}</span>
                </div>
                {resultB && (
                  <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{resultB.latencyMs}ms</span>
                    <span className="flex items-center gap-1"><Zap className="h-3 w-3" />{resultB.inputTokens + resultB.outputTokens} tok</span>
                    <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />${resultB.cost.toFixed(4)}</span>
                    <button onClick={() => handleCopy(resultB.output, "b")} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-800">
                      {copied === "b" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                )}
              </div>
              <div className="p-4">
                {running && !resultB ? (
                  <div className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Generating...</div>
                ) : resultB ? (
                  <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">{resultB.output}</div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Comparison summary */}
      {compareMode && resultA && resultB && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-300">Comparison Summary</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-zinc-800 text-zinc-500">
                <th className="pb-2 text-left font-medium">Metric</th>
                <th className="pb-2 text-right font-medium">{resultA.model}</th>
                <th className="pb-2 text-right font-medium">{resultB.model}</th>
                <th className="pb-2 text-right font-medium">Winner</th>
              </tr></thead>
              <tbody>
                {[
                  { label: "Latency", a: `${resultA.latencyMs}ms`, b: `${resultB.latencyMs}ms`, winner: resultA.latencyMs < resultB.latencyMs ? "a" : "b" },
                  { label: "Output Length", a: `${resultA.outputTokens} tok`, b: `${resultB.outputTokens} tok`, winner: resultA.outputTokens > resultB.outputTokens ? "a" : "b" },
                  { label: "Cost", a: `$${resultA.cost.toFixed(4)}`, b: `$${resultB.cost.toFixed(4)}`, winner: resultA.cost < resultB.cost ? "a" : "b" },
                  { label: "Total Tokens", a: `${resultA.inputTokens + resultA.outputTokens}`, b: `${resultB.inputTokens + resultB.outputTokens}`, winner: resultA.inputTokens + resultA.outputTokens < resultB.inputTokens + resultB.outputTokens ? "a" : "b" },
                ].map((row) => (
                  <tr key={row.label} className="border-b border-zinc-800/50">
                    <td className="py-2 text-zinc-400">{row.label}</td>
                    <td className={cn("py-2 text-right", row.winner === "a" ? "font-semibold text-emerald-400" : "text-zinc-300")}>{row.a}</td>
                    <td className={cn("py-2 text-right", row.winner === "b" ? "font-semibold text-emerald-400" : "text-zinc-300")}>{row.b}</td>
                    <td className="py-2 text-right text-emerald-400">{row.winner === "a" ? resultA.model : resultB.model}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
