import { useState } from "react";
import {
  Activity,
  Play,
  Pause,
  XCircle,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RotateCcw,
  Zap,
  TrendingUp,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

type RunStatus = "running" | "completed" | "failed" | "paused" | "dead_letter" | "waiting_approval";

interface DurableRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  currentStep: string;
  stepsCompleted: number;
  totalSteps: number;
  startedAt: string;
  durationMs: number;
  retries: number;
  agentId: string;
}

const now = Date.now();
const min = 60_000;

const mockRuns: DurableRun[] = [
  { id: "run-001", workflowId: "seo-audit-flow", workflowName: "Weekly SEO Audit", status: "running", currentStep: "crawl_pages", stepsCompleted: 3, totalSteps: 7, startedAt: new Date(now - 12 * min).toISOString(), durationMs: 12 * min, retries: 0, agentId: "seo-ops" },
  { id: "run-002", workflowId: "cloud-drift-scan", workflowName: "Cloud Drift Detection", status: "waiting_approval", currentStep: "apply_remediation", stepsCompleted: 4, totalSteps: 5, startedAt: new Date(now - 8 * min).toISOString(), durationMs: 8 * min, retries: 0, agentId: "cloud-health" },
  { id: "run-003", workflowId: "cost-optimization", workflowName: "Cost Optimization Sweep", status: "completed", currentStep: "done", stepsCompleted: 6, totalSteps: 6, startedAt: new Date(now - 45 * min).toISOString(), durationMs: 32 * min, retries: 1, agentId: "cloud-health" },
  { id: "run-004", workflowId: "content-gap-analysis", workflowName: "Content Gap Analysis", status: "failed", currentStep: "fetch_competitor_data", stepsCompleted: 2, totalSteps: 5, startedAt: new Date(now - 60 * min).toISOString(), durationMs: 15 * min, retries: 3, agentId: "seo-ops" },
  { id: "run-005", workflowId: "cert-renewal", workflowName: "Certificate Auto-Renewal", status: "completed", currentStep: "done", stepsCompleted: 4, totalSteps: 4, startedAt: new Date(now - 120 * min).toISOString(), durationMs: 5 * min, retries: 0, agentId: "cloud-health" },
  { id: "run-006", workflowId: "weekly-report", workflowName: "Weekly Operations Report", status: "paused", currentStep: "aggregate_metrics", stepsCompleted: 1, totalSteps: 4, startedAt: new Date(now - 30 * min).toISOString(), durationMs: 4 * min, retries: 0, agentId: "orchestrator" },
  { id: "run-007", workflowId: "backlink-monitor", workflowName: "Backlink Health Check", status: "dead_letter", currentStep: "verify_links", stepsCompleted: 3, totalSteps: 5, startedAt: new Date(now - 180 * min).toISOString(), durationMs: 90 * min, retries: 5, agentId: "seo-ops" },
];

const statusConfig: Record<RunStatus, { label: string; color: string; icon: typeof Activity }> = {
  running: { label: "Running", color: "text-sky-400", icon: Play },
  completed: { label: "Completed", color: "text-emerald-400", icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-red-400", icon: XCircle },
  paused: { label: "Paused", color: "text-amber-400", icon: Pause },
  dead_letter: { label: "Dead Letter", color: "text-red-500", icon: AlertTriangle },
  waiting_approval: { label: "Awaiting Approval", color: "text-violet-400", icon: Clock },
};

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export default function OpsConsolePage() {
  const [statusFilter, setStatusFilter] = useState<RunStatus | "all">("all");

  const filtered = statusFilter === "all" ? mockRuns : mockRuns.filter((r) => r.status === statusFilter);
  const running = mockRuns.filter((r) => r.status === "running").length;
  const pending = mockRuns.filter((r) => r.status === "waiting_approval").length;
  const failed = mockRuns.filter((r) => r.status === "failed" || r.status === "dead_letter").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Operations Console</h1>
          <p className="text-sm text-zinc-400 mt-1">Durable workflow execution and monitoring</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors">
            <Play className="w-3.5 h-3.5 inline mr-1.5" />New Run
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Active Runs", value: running, icon: Zap, color: "text-sky-400" },
          { label: "Awaiting Approval", value: pending, icon: Clock, color: "text-violet-400" },
          { label: "Failed / Dead Letter", value: failed, icon: AlertTriangle, color: "text-red-400" },
          { label: "Success Rate (24h)", value: "87%", icon: TrendingUp, color: "text-emerald-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <stat.icon className={cn("w-4 h-4", stat.color)} />
              <span className="text-xs text-zinc-500">{stat.label}</span>
            </div>
            <span className="text-xl font-bold text-zinc-100">{stat.value}</span>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-400">Filter:</span>
        {(["all", "running", "waiting_approval", "paused", "failed", "dead_letter", "completed"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-2.5 py-1 rounded text-xs font-medium transition-colors",
              statusFilter === s ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {s === "all" ? "All" : statusConfig[s]?.label ?? s}
          </button>
        ))}
      </div>

      {/* Runs Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Workflow</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Progress</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Agent</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Duration</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {filtered.map((run) => {
              const cfg = statusConfig[run.status];
              const StatusIcon = cfg.icon;
              const progress = Math.round((run.stepsCompleted / run.totalSteps) * 100);
              return (
                <tr key={run.id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-zinc-200">{run.workflowName}</div>
                    <div className="text-xs text-zinc-500">{run.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", cfg.color)}>
                      <StatusIcon className="w-3.5 h-3.5" />{cfg.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full", run.status === "failed" || run.status === "dead_letter" ? "bg-red-500" : "bg-sky-500")} style={{ width: `${progress}%` }} />
                      </div>
                      <span className="text-xs text-zinc-500">{run.stepsCompleted}/{run.totalSteps}</span>
                    </div>
                    <div className="text-xs text-zinc-600 mt-0.5">{run.currentStep}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400">{run.agentId}</td>
                  <td className="px-4 py-3">
                    <span className="text-sm text-zinc-300">{formatDuration(run.durationMs)}</span>
                    {run.retries > 0 && <span className="text-xs text-amber-500 ml-1">({run.retries} retries)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {run.status === "running" && (
                        <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-amber-400" title="Pause"><Pause className="w-3.5 h-3.5" /></button>
                      )}
                      {run.status === "paused" && (
                        <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-sky-400" title="Resume"><Play className="w-3.5 h-3.5" /></button>
                      )}
                      {(run.status === "failed" || run.status === "dead_letter") && (
                        <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-emerald-400" title="Retry"><RotateCcw className="w-3.5 h-3.5" /></button>
                      )}
                      {run.status !== "completed" && (
                        <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-red-400" title="Cancel"><XCircle className="w-3.5 h-3.5" /></button>
                      )}
                      <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200" title="Details"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
