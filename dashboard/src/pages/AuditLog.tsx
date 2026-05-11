import { useState } from "react";
import {
  Shield,
  Search,
  Filter,
  User,
  Bot,
  Settings,
  Key,
  Trash2,
  Plus,
  Edit3,
  LogIn,
  LogOut,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

type AuditAction = "login" | "logout" | "create" | "update" | "delete" | "config_change" | "key_rotate" | "agent_start" | "agent_stop" | "export" | "import";

interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorType: "user" | "system" | "agent";
  action: AuditAction;
  resource: string;
  resourceId?: string;
  details: string;
  ip?: string;
  severity: "info" | "warning" | "critical";
}

const now = Date.now();
const hr = 3_600_000;

const mockAuditLog: AuditEntry[] = [
  { id: "a01", timestamp: new Date(now - hr * 0.1).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "config_change", resource: "Model Router", details: "Changed primary reasoning model from Sonnet 4.6 to Opus 4.7", severity: "warning" },
  { id: "a02", timestamp: new Date(now - hr * 0.3).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "login", resource: "Auth", details: "Logged in from 192.168.1.42", ip: "192.168.1.42", severity: "info" },
  { id: "a03", timestamp: new Date(now - hr * 1.2).toISOString(), actor: "Orchestrator", actorType: "agent", action: "agent_start", resource: "Agent", resourceId: "researcher", details: "Spawned Research Agent for task: AI paper review", severity: "info" },
  { id: "a04", timestamp: new Date(now - hr * 2.5).toISOString(), actor: "system", actorType: "system", action: "key_rotate", resource: "API Key", resourceId: "anthropic-key-1", details: "Rotated Anthropic API key (expires in 90d)", severity: "warning" },
  { id: "a05", timestamp: new Date(now - hr * 3.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "create", resource: "Scheduled Task", resourceId: "st-007", details: "Created daily research digest task for Research Agent", severity: "info" },
  { id: "a06", timestamp: new Date(now - hr * 4.2).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "update", resource: "Agent", resourceId: "coder", details: "Updated Code Assistant: added 'security-scan' skill, changed maxCalls from 30 to 40", severity: "info" },
  { id: "a07", timestamp: new Date(now - hr * 5.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "delete", resource: "Memory Entry", resourceId: "m-old-42", details: "Deleted 3 ephemeral memory entries older than 30 days", severity: "warning" },
  { id: "a08", timestamp: new Date(now - hr * 6.5).toISOString(), actor: "system", actorType: "system", action: "agent_stop", resource: "Agent", resourceId: "writer", details: "Stopped Content Writer: rate limit exceeded on Groq provider", severity: "critical" },
  { id: "a09", timestamp: new Date(now - hr * 8.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "export", resource: "Config", details: "Exported full configuration bundle (5 agents, 6 schedules, settings)", severity: "info" },
  { id: "a10", timestamp: new Date(now - hr * 12.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "config_change", resource: "Guardrails", details: "Enabled toxicity filter for all agents, threshold: 0.7", severity: "warning" },
  { id: "a11", timestamp: new Date(now - hr * 18.0).toISOString(), actor: "unknown@external.com", actorType: "user", action: "login", resource: "Auth", details: "Failed login attempt from 203.0.113.50", ip: "203.0.113.50", severity: "critical" },
  { id: "a12", timestamp: new Date(now - hr * 20.0).toISOString(), actor: "system", actorType: "system", action: "import", resource: "Config", details: "Auto-imported agent config from AGENT.md (git pull)", severity: "info" },
  { id: "a13", timestamp: new Date(now - hr * 24.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "create", resource: "Agent", resourceId: "data-analyst", details: "Created Data Analyst agent with Gemini 2.5 Flash, 3 skills", severity: "info" },
  { id: "a14", timestamp: new Date(now - hr * 30.0).toISOString(), actor: "Orchestrator", actorType: "agent", action: "config_change", resource: "Memory", details: "Auto-pruned 47 expired ephemeral memory entries", severity: "info" },
  { id: "a15", timestamp: new Date(now - hr * 36.0).toISOString(), actor: "admin@openastra.dev", actorType: "user", action: "logout", resource: "Auth", details: "Logged out", severity: "info" },
];

const actionIcons: Record<AuditAction, typeof Shield> = {
  login: LogIn, logout: LogOut, create: Plus, update: Edit3, delete: Trash2,
  config_change: Settings, key_rotate: Key, agent_start: Bot, agent_stop: Bot,
  export: RefreshCw, import: RefreshCw,
};

const actionLabels: Record<AuditAction, string> = {
  login: "Login", logout: "Logout", create: "Create", update: "Update", delete: "Delete",
  config_change: "Config Change", key_rotate: "Key Rotation", agent_start: "Agent Start",
  agent_stop: "Agent Stop", export: "Export", import: "Import",
};

const severityStyles = {
  info: "bg-zinc-800 text-zinc-400",
  warning: "bg-amber-500/10 text-amber-400",
  critical: "bg-red-500/10 text-red-400",
};

const actorIcons = { user: User, system: Shield, agent: Bot };

function formatTime(iso: string): string {
  const diff = now - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AuditLogPage() {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = mockAuditLog.filter((entry) => {
    if (severityFilter !== "all" && entry.severity !== severityFilter) return false;
    if (actionFilter !== "all" && entry.action !== actionFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return entry.actor.toLowerCase().includes(q) || entry.details.toLowerCase().includes(q) || entry.resource.toLowerCase().includes(q);
    }
    return true;
  });

  const criticalCount = mockAuditLog.filter((e) => e.severity === "critical").length;
  const todayCount = mockAuditLog.filter((e) => now - new Date(e.timestamp).getTime() < 86_400_000).length;
  const uniqueActors = new Set(mockAuditLog.map((e) => e.actor)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-sm text-zinc-500">Tamper-evident log of all administrative actions</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total Events", value: mockAuditLog.length, icon: Shield, color: "text-sky-400" },
          { label: "Today", value: todayCount, icon: RefreshCw, color: "text-emerald-400" },
          { label: "Critical", value: criticalCount, icon: Trash2, color: "text-red-400" },
          { label: "Unique Actors", value: uniqueActors, icon: User, color: "text-violet-400" },
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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actor, resource, details..."
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-1">
          <Filter className="ml-1.5 h-3 w-3 text-zinc-600" />
          {["all", "info", "warning", "critical"].map((s) => (
            <button key={s} onClick={() => setSeverityFilter(s)} className={cn("rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors", severityFilter === s ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300")}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-1">
          {["all", "login", "create", "update", "delete", "config_change"].map((a) => (
            <button key={a} onClick={() => setActionFilter(a)} className={cn("rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors", actionFilter === a ? "bg-sky-500/10 text-sky-400" : "text-zinc-500 hover:text-zinc-300")}>
              {a === "all" ? "All" : a === "config_change" ? "Config" : a}
            </button>
          ))}
        </div>
      </div>

      {/* Log entries */}
      <div className="space-y-1">
        {filtered.map((entry) => {
          const ActionIcon = actionIcons[entry.action] ?? Shield;
          const ActorIcon = actorIcons[entry.actorType];
          const isExpanded = expandedId === entry.id;
          return (
            <button
              key={entry.id}
              onClick={() => setExpandedId(isExpanded ? null : entry.id)}
              className={cn(
                "w-full rounded-xl border text-left transition-all",
                isExpanded ? "border-zinc-700 bg-zinc-800/30" : "border-zinc-800/50 bg-zinc-900/30 hover:bg-zinc-800/20",
              )}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", entry.severity === "critical" ? "bg-red-500/10" : entry.severity === "warning" ? "bg-amber-500/10" : "bg-zinc-800")}>
                  <ActionIcon className={cn("h-3.5 w-3.5", entry.severity === "critical" ? "text-red-400" : entry.severity === "warning" ? "text-amber-400" : "text-zinc-500")} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-200">{actionLabels[entry.action]}</span>
                    <span className="text-[10px] text-zinc-600">•</span>
                    <span className="text-[11px] text-zinc-400">{entry.resource}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-zinc-500">{entry.details}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={cn("rounded-full px-2 py-0.5 text-[9px] font-medium", severityStyles[entry.severity])}>
                    {entry.severity}
                  </span>
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <ActorIcon className="h-3 w-3" />
                    <span className="hidden sm:inline">{entry.actor}</span>
                  </div>
                  <span className="w-14 text-right text-[10px] text-zinc-600">{formatTime(entry.timestamp)}</span>
                  <ChevronDown className={cn("h-3 w-3 text-zinc-600 transition-transform", isExpanded && "rotate-180")} />
                </div>
              </div>
              {isExpanded && (
                <div className="border-t border-zinc-800 px-4 py-3 space-y-2 text-[11px]">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div><span className="text-zinc-600">Timestamp</span><p className="text-zinc-300">{new Date(entry.timestamp).toLocaleString()}</p></div>
                    <div><span className="text-zinc-600">Actor</span><p className="text-zinc-300">{entry.actor}</p></div>
                    <div><span className="text-zinc-600">Actor Type</span><p className="capitalize text-zinc-300">{entry.actorType}</p></div>
                    {entry.ip && <div><span className="text-zinc-600">IP Address</span><p className="text-zinc-300">{entry.ip}</p></div>}
                    {entry.resourceId && <div><span className="text-zinc-600">Resource ID</span><p className="font-mono text-zinc-300">{entry.resourceId}</p></div>}
                  </div>
                  <div><span className="text-zinc-600">Details</span><p className="text-zinc-300">{entry.details}</p></div>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
