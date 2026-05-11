import { useState } from "react";
import {
  User,
  Brain,
  Heart,
  Code2,
  Globe,
  Trash2,
  Edit3,
  Check,
  X,
  Clock,
  Sparkles,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProfileInference {
  id: string;
  category: "preference" | "skill" | "personality" | "context" | "goal";
  content: string;
  confidence: number;
  source: string;
  learnedAt: string;
  verified: boolean;
}

const now = Date.now();
const day = 86_400_000;

const mockInferences: ProfileInference[] = [
  { id: "i1", category: "skill", content: "Primary languages: TypeScript, Python, Rust", confidence: 0.95, source: "Multiple code review sessions", learnedAt: new Date(now - day * 30).toISOString(), verified: true },
  { id: "i2", category: "preference", content: "Prefers concise responses with code examples over lengthy explanations", confidence: 0.88, source: "Feedback patterns across 12 sessions", learnedAt: new Date(now - day * 25).toISOString(), verified: true },
  { id: "i3", category: "context", content: "Works at an early-stage startup building an AI agent runtime", confidence: 0.92, source: "Conversation context and project files", learnedAt: new Date(now - day * 40).toISOString(), verified: true },
  { id: "i4", category: "personality", content: "Direct communication style, values efficiency over politeness", confidence: 0.78, source: "Response feedback patterns", learnedAt: new Date(now - day * 20).toISOString(), verified: false },
  { id: "i5", category: "goal", content: "Building a production-ready dashboard to compete with OpenClaw and Hermes", confidence: 0.85, source: "Recent task context", learnedAt: new Date(now - day * 2).toISOString(), verified: false },
  { id: "i6", category: "preference", content: "Dark theme UI, minimal use of emojis, prefers monospace fonts for code", confidence: 0.82, source: "UI customization choices", learnedAt: new Date(now - day * 15).toISOString(), verified: false },
  { id: "i7", category: "skill", content: "Strong with React, Tailwind, Zustand state management", confidence: 0.9, source: "Code patterns in dashboard project", learnedAt: new Date(now - day * 10).toISOString(), verified: true },
  { id: "i8", category: "context", content: "Timezone appears to be US Eastern (based on activity patterns)", confidence: 0.65, source: "Session timing analysis", learnedAt: new Date(now - day * 35).toISOString(), verified: false },
  { id: "i9", category: "preference", content: "Likes to build features in parallel batches rather than sequentially", confidence: 0.75, source: "Task delegation patterns", learnedAt: new Date(now - day * 5).toISOString(), verified: false },
  { id: "i10", category: "goal", content: "Interested in observability, tracing, and LLM cost optimization", confidence: 0.8, source: "Feature requests and research queries", learnedAt: new Date(now - day * 3).toISOString(), verified: false },
  { id: "i11", category: "skill", content: "Familiar with WebSocket, SSE, JWT authentication patterns", confidence: 0.85, source: "Implementation decisions", learnedAt: new Date(now - day * 8).toISOString(), verified: true },
  { id: "i12", category: "personality", content: "Iterative builder — likes to see progress quickly, then refine", confidence: 0.72, source: "Work pattern analysis", learnedAt: new Date(now - day * 12).toISOString(), verified: false },
];

const categoryConfig: Record<string, { icon: typeof User; color: string; bg: string; label: string }> = {
  preference: { icon: Heart, color: "text-rose-400", bg: "bg-rose-500/10", label: "Preference" },
  skill: { icon: Code2, color: "text-sky-400", bg: "bg-sky-500/10", label: "Skill" },
  personality: { icon: Sparkles, color: "text-violet-400", bg: "bg-violet-500/10", label: "Personality" },
  context: { icon: Globe, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Context" },
  goal: { icon: Brain, color: "text-amber-400", bg: "bg-amber-500/10", label: "Goal" },
};

export function UserProfilePage() {
  const [inferences, setInferences] = useState(mockInferences);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const filtered = categoryFilter === "all" ? inferences : inferences.filter((i) => i.category === categoryFilter);

  const handleDelete = (id: string) => {
    setInferences((prev) => prev.filter((i) => i.id !== id));
  };

  const handleVerify = (id: string) => {
    setInferences((prev) => prev.map((i) => (i.id === id ? { ...i, verified: !i.verified } : i)));
  };

  const startEdit = (inf: ProfileInference) => {
    setEditingId(inf.id);
    setEditText(inf.content);
  };

  const saveEdit = (id: string) => {
    setInferences((prev) => prev.map((i) => (i.id === id ? { ...i, content: editText } : i)));
    setEditingId(null);
  };

  const verifiedCount = inferences.filter((i) => i.verified).length;
  const avgConfidence = Math.round((inferences.reduce((s, i) => s + i.confidence, 0) / inferences.length) * 100);
  const categories = new Set(inferences.map((i) => i.category)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">User Profile</h1>
        <p className="text-sm text-zinc-500">What the agent has learned about you — review, correct, or delete</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total Inferences", value: inferences.length, icon: Brain, color: "text-sky-400" },
          { label: "Verified", value: verifiedCount, icon: Shield, color: "text-emerald-400" },
          { label: "Avg Confidence", value: `${avgConfidence}%`, icon: Sparkles, color: "text-violet-400" },
          { label: "Categories", value: categories, icon: User, color: "text-amber-400" },
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

      {/* Privacy notice */}
      <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div className="text-xs text-sky-300">
          <p className="font-medium">Privacy-first design</p>
          <p className="mt-0.5 text-sky-400/70">All profile data is stored locally. You can edit, verify, or delete any inference at any time. Nothing is shared externally.</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        {["all", "preference", "skill", "personality", "context", "goal"].map((cat) => (
          <button key={cat} onClick={() => setCategoryFilter(cat)} className={cn("rounded-md px-2.5 py-1.5 text-[11px] font-medium capitalize transition-colors", categoryFilter === cat ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300")}>
            {cat}
          </button>
        ))}
      </div>

      {/* Inferences */}
      <div className="space-y-2">
        {filtered.map((inf) => {
          const cat = categoryConfig[inf.category]!;
          const Icon = cat.icon;
          const isEditing = editingId === inf.id;
          return (
            <div key={inf.id} className={cn("rounded-xl border bg-zinc-900/50 p-4 transition-all", inf.verified ? "border-emerald-500/20" : "border-zinc-800")}>
              <div className="flex items-start gap-3">
                <div className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", cat.bg)}>
                  <Icon className={cn("h-3.5 w-3.5", cat.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                        autoFocus
                      />
                      <button onClick={() => saveEdit(inf.id)} className="rounded p-1 text-emerald-400 hover:bg-emerald-500/10"><Check className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditingId(null)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-200">{inf.content}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                    <span className={cn("rounded-full px-2 py-0.5 font-medium", cat.bg, cat.color)}>{cat.label}</span>
                    <span className="text-zinc-500">Confidence: <span className={cn("font-medium", inf.confidence >= 0.8 ? "text-emerald-400" : inf.confidence >= 0.6 ? "text-amber-400" : "text-red-400")}>{Math.round(inf.confidence * 100)}%</span></span>
                    <span className="flex items-center gap-1 text-zinc-600"><Clock className="h-2.5 w-2.5" />{Math.floor((now - new Date(inf.learnedAt).getTime()) / day)}d ago</span>
                    <span className="text-zinc-600">Source: {inf.source}</span>
                    {inf.verified && <span className="flex items-center gap-0.5 text-emerald-400"><Check className="h-2.5 w-2.5" />Verified</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => handleVerify(inf.id)} title={inf.verified ? "Unverify" : "Verify"} className={cn("rounded p-1.5 transition-colors", inf.verified ? "text-emerald-400 hover:bg-emerald-500/10" : "text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300")}>
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => startEdit(inf)} title="Edit" className="rounded p-1.5 text-zinc-600 transition-colors hover:bg-zinc-800 hover:text-zinc-300">
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => handleDelete(inf.id)} title="Delete" className="rounded p-1.5 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
