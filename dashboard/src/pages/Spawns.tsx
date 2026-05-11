import { useState } from "react";
import {
  GitFork,
  Bot,
  Layers,
  DollarSign,
  Zap,
  Check,
  AlertCircle,
  Wrench,
  ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SpawnStatus = "working" | "completed" | "error" | "delegating";

interface SpawnNode {
  id: string;
  agentName: string;
  model: string;
  task: string;
  status: SpawnStatus;
  depth: number;
  startedAt: string;
  duration: number;
  tokenCount: number;
  cost: number;
  toolCalls: { name: string; duration: string; status: "done" | "running" | "error" }[];
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  children: SpawnNode[];
}

interface SpawnTree {
  id: string;
  label: string;
  startedAt: string;
  status: SpawnStatus;
  subagentCount: number;
  root: SpawnNode;
}

const now = Date.now();

const mockTrees: SpawnTree[] = [
  {
    id: "tree-1",
    label: "Research latest AI papers and compile report",
    startedAt: new Date(now - 720_000).toISOString(),
    status: "working",
    subagentCount: 4,
    root: {
      id: "n1", agentName: "Orchestrator", model: "claude-sonnet-4-20250514", task: "Coordinate research on latest AI papers and compile a comprehensive report",
      status: "delegating", depth: 0, startedAt: new Date(now - 720_000).toISOString(), duration: 720, tokenCount: 8200, cost: 0.024,
      toolCalls: [{ name: "plan_tasks", duration: "0.3s", status: "done" }, { name: "delegate", duration: "0.1s", status: "done" }],
      messageCount: 6, inputTokens: 5400, outputTokens: 2800,
      children: [
        {
          id: "n2", agentName: "Research Agent", model: "gpt-4o", task: "Search for and summarize top 5 arxiv papers on multi-agent systems",
          status: "working", depth: 1, startedAt: new Date(now - 600_000).toISOString(), duration: 600, tokenCount: 24500, cost: 0.073,
          toolCalls: [{ name: "web_search", duration: "1.2s", status: "done" }, { name: "read_url", duration: "2.4s", status: "done" }, { name: "read_url", duration: "1.8s", status: "done" }, { name: "summarize", duration: "3.1s", status: "running" }],
          messageCount: 12, inputTokens: 18200, outputTokens: 6300,
          children: [
            {
              id: "n3", agentName: "Fact Checker", model: "claude-haiku-4-5-20251001", task: "Verify claims and citations from research summaries",
              status: "working", depth: 2, startedAt: new Date(now - 300_000).toISOString(), duration: 300, tokenCount: 6800, cost: 0.007,
              toolCalls: [{ name: "web_search", duration: "0.9s", status: "done" }, { name: "verify_citation", duration: "1.4s", status: "running" }],
              messageCount: 5, inputTokens: 4200, outputTokens: 2600, children: [],
            },
            {
              id: "n4", agentName: "Source Validator", model: "claude-haiku-4-5-20251001", task: "Score credibility of research sources",
              status: "completed", depth: 2, startedAt: new Date(now - 450_000).toISOString(), duration: 180, tokenCount: 3200, cost: 0.003,
              toolCalls: [{ name: "check_journal_ranking", duration: "0.5s", status: "done" }, { name: "check_author_hindex", duration: "0.8s", status: "done" }],
              messageCount: 4, inputTokens: 2100, outputTokens: 1100, children: [],
            },
          ],
        },
        {
          id: "n5", agentName: "Content Writer", model: "claude-sonnet-4-20250514", task: "Draft the final compiled report from research findings",
          status: "working", depth: 1, startedAt: new Date(now - 200_000).toISOString(), duration: 200, tokenCount: 5400, cost: 0.016,
          toolCalls: [{ name: "draft", duration: "4.2s", status: "running" }],
          messageCount: 3, inputTokens: 3800, outputTokens: 1600, children: [],
        },
      ],
    },
  },
  {
    id: "tree-2",
    label: "Refactor auth module and add test coverage",
    startedAt: new Date(now - 1_200_000).toISOString(),
    status: "working",
    subagentCount: 3,
    root: {
      id: "n6", agentName: "Orchestrator", model: "claude-sonnet-4-20250514", task: "Coordinate auth module refactoring with test coverage",
      status: "delegating", depth: 0, startedAt: new Date(now - 1_200_000).toISOString(), duration: 1200, tokenCount: 6100, cost: 0.018,
      toolCalls: [{ name: "read_file", duration: "0.1s", status: "done" }, { name: "plan_tasks", duration: "0.5s", status: "done" }],
      messageCount: 8, inputTokens: 4200, outputTokens: 1900,
      children: [
        {
          id: "n7", agentName: "Code Assistant", model: "claude-sonnet-4-20250514", task: "Refactor JWT handling to use middleware pattern",
          status: "completed", depth: 1, startedAt: new Date(now - 1_000_000).toISOString(), duration: 480, tokenCount: 18200, cost: 0.054,
          toolCalls: [{ name: "read_file", duration: "0.1s", status: "done" }, { name: "write_file", duration: "0.2s", status: "done" }, { name: "read_file", duration: "0.1s", status: "done" }, { name: "write_file", duration: "0.2s", status: "done" }],
          messageCount: 10, inputTokens: 12400, outputTokens: 5800,
          children: [
            {
              id: "n8", agentName: "Test Runner", model: "gemini-2.5-flash", task: "Run existing auth tests and report failures",
              status: "completed", depth: 2, startedAt: new Date(now - 800_000).toISOString(), duration: 120, tokenCount: 4200, cost: 0.004,
              toolCalls: [{ name: "execute_code", duration: "8.2s", status: "done" }],
              messageCount: 3, inputTokens: 2800, outputTokens: 1400, children: [],
            },
            {
              id: "n9", agentName: "Linter", model: "gemini-2.5-flash", task: "Lint refactored files and fix violations",
              status: "completed", depth: 2, startedAt: new Date(now - 780_000).toISOString(), duration: 60, tokenCount: 2100, cost: 0.002,
              toolCalls: [{ name: "execute_code", duration: "3.1s", status: "done" }],
              messageCount: 2, inputTokens: 1400, outputTokens: 700, children: [],
            },
          ],
        },
        {
          id: "n10", agentName: "Code Reviewer", model: "claude-sonnet-4-20250514", task: "Review refactored auth code for security issues",
          status: "working", depth: 1, startedAt: new Date(now - 400_000).toISOString(), duration: 400, tokenCount: 9800, cost: 0.029,
          toolCalls: [{ name: "read_file", duration: "0.1s", status: "done" }, { name: "read_file", duration: "0.1s", status: "done" }, { name: "search_codebase", duration: "1.2s", status: "running" }],
          messageCount: 6, inputTokens: 7200, outputTokens: 2600, children: [],
        },
      ],
    },
  },
  {
    id: "tree-3",
    label: "Analyze Q1 revenue anomalies",
    startedAt: new Date(now - 540_000).toISOString(),
    status: "error",
    subagentCount: 2,
    root: {
      id: "n11", agentName: "Data Analyst", model: "gemini-2.5-flash", task: "Investigate revenue dip on April 15 and generate incident report",
      status: "delegating", depth: 0, startedAt: new Date(now - 540_000).toISOString(), duration: 540, tokenCount: 7800, cost: 0.008,
      toolCalls: [{ name: "sql_query", duration: "0.5s", status: "done" }, { name: "delegate", duration: "0.1s", status: "done" }],
      messageCount: 5, inputTokens: 5200, outputTokens: 2600,
      children: [
        {
          id: "n12", agentName: "Chart Generator", model: "gemini-2.5-flash", task: "Generate revenue trend charts with anomaly annotations",
          status: "completed", depth: 1, startedAt: new Date(now - 400_000).toISOString(), duration: 180, tokenCount: 4500, cost: 0.005,
          toolCalls: [{ name: "execute_code", duration: "2.8s", status: "done" }, { name: "chart", duration: "1.2s", status: "done" }],
          messageCount: 4, inputTokens: 3000, outputTokens: 1500, children: [],
        },
        {
          id: "n13", agentName: "SQL Runner", model: "gemini-2.5-flash", task: "Query order and payment tables for April 15 transaction details",
          status: "error", depth: 1, startedAt: new Date(now - 350_000).toISOString(), duration: 90, tokenCount: 2100, cost: 0.002,
          toolCalls: [{ name: "sql_query", duration: "0.3s", status: "done" }, { name: "sql_query", duration: "15.0s", status: "error" }],
          messageCount: 3, inputTokens: 1400, outputTokens: 700,
          children: [
            {
              id: "n14", agentName: "Cache Builder", model: "gemini-2.5-flash", task: "Build materialized view for payment gateway logs",
              status: "error", depth: 2, startedAt: new Date(now - 300_000).toISOString(), duration: 45, tokenCount: 800, cost: 0.001,
              toolCalls: [{ name: "sql_query", duration: "30.0s", status: "error" }],
              messageCount: 2, inputTokens: 500, outputTokens: 300, children: [],
            },
          ],
        },
      ],
    },
  },
];

const statusConfig: Record<SpawnStatus, { label: string; color: string; bg: string; icon: typeof Check }> = {
  working: { label: "Working", color: "text-amber-400", bg: "border-amber-500/30 shadow-[0_0_8px_rgba(245,158,11,0.1)]", icon: Zap },
  completed: { label: "Done", color: "text-emerald-400", bg: "border-emerald-500/30", icon: Check },
  error: { label: "Error", color: "text-red-400", bg: "border-red-500/30 shadow-[0_0_8px_rgba(239,68,68,0.1)]", icon: AlertCircle },
  delegating: { label: "Delegating", color: "text-violet-400", bg: "border-violet-500/30 shadow-[0_0_8px_rgba(139,92,246,0.1)]", icon: ArrowRightLeft },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

function collectNodes(node: SpawnNode): SpawnNode[] {
  return [node, ...node.children.flatMap(collectNodes)];
}

function TreeNode({
  node,
  selectedId,
  onSelect,
}: {
  node: SpawnNode;
  selectedId: string | null;
  onSelect: (n: SpawnNode) => void;
  isLast?: boolean;
}) {
  const sc = statusConfig[node.status];
  const Icon = sc.icon;
  const isSelected = selectedId === node.id;

  return (
    <div className="flex flex-col">
      <div className="flex items-stretch">
        {/* Node card */}
        <button
          onClick={() => onSelect(node)}
          className={cn(
            "w-56 shrink-0 rounded-xl border bg-zinc-900/80 p-3 text-left transition-all hover:bg-zinc-800/60",
            isSelected ? "border-sky-500/50 ring-1 ring-sky-500/20" : sc.bg,
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Icon className={cn("h-3.5 w-3.5", sc.color)} />
              <span className="text-xs font-semibold">{node.agentName}</span>
            </div>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">L{node.depth}</span>
          </div>
          <p className="mt-1 truncate text-[11px] text-zinc-400">{node.task}</p>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-500">
            <span>{formatDuration(node.duration)}</span>
            <span>{(node.tokenCount / 1000).toFixed(1)}K tok</span>
            <span>{formatCost(node.cost)}</span>
          </div>
          <div className="mt-1">
            <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", {
              "bg-amber-500/10 text-amber-400": node.status === "working",
              "bg-emerald-500/10 text-emerald-400": node.status === "completed",
              "bg-red-500/10 text-red-400": node.status === "error",
              "bg-violet-500/10 text-violet-400": node.status === "delegating",
            })}>
              {sc.label}
            </span>
          </div>
        </button>

        {/* Connector + children */}
        {node.children.length > 0 && (
          <div className="flex items-center">
            <div className="w-6 border-t border-zinc-700" />
            <div className="flex flex-col">
              {node.children.map((child, i) => (
                <div key={child.id} className="flex items-center">
                  {node.children.length > 1 && (
                    <div className="relative flex h-full w-4 flex-col items-center">
                      <div className={cn("w-px flex-1", i === 0 ? "bg-transparent" : "bg-zinc-700")} />
                      <div className="h-px w-4 bg-zinc-700" />
                      <div className={cn("w-px flex-1", i === node.children.length - 1 ? "bg-transparent" : "bg-zinc-700")} />
                    </div>
                  )}
                  {node.children.length === 1 && <div className="w-4 border-t border-zinc-700" />}
                  <TreeNode node={child} selectedId={selectedId} onSelect={onSelect} isLast={i === node.children.length - 1} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SpawnsPage() {
  const [selectedTreeId, setSelectedTreeId] = useState(mockTrees[0]!.id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const tree = mockTrees.find((t) => t.id === selectedTreeId) ?? mockTrees[0]!;
  const allNodes = collectNodes(tree.root);
  const selectedNode = selectedNodeId ? allNodes.find((n) => n.id === selectedNodeId) : null;

  const totalSubagents = mockTrees.reduce((sum, t) => sum + t.subagentCount, 0);
  const avgDepth = (allNodes.reduce((sum, n) => sum + n.depth, 0) / allNodes.length).toFixed(1);
  const totalCost = allNodes.reduce((sum, n) => sum + n.cost, 0);

  const depthStats = Array.from({ length: 3 }, (_, d) => {
    const nodes = allNodes.filter((n) => n.depth === d);
    const tokens = nodes.reduce((s, n) => s + n.tokenCount, 0);
    const completed = nodes.filter((n) => n.status === "completed").length;
    const total = nodes.length;
    const avgDur = nodes.length ? Math.round(nodes.reduce((s, n) => s + n.duration, 0) / nodes.length) : 0;
    return { depth: d, tokens, successRate: total ? Math.round((completed / total) * 100) : 0, avgDuration: avgDur, count: total };
  });
  const maxTokens = Math.max(...depthStats.map((d) => d.tokens), 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Subagent Spawns</h1>
        <p className="text-sm text-zinc-500">Visualize agent delegation trees and task orchestration</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Active Trees", value: mockTrees.length, icon: GitFork, color: "text-sky-400" },
          { label: "Subagents Running", value: totalSubagents, icon: Bot, color: "text-amber-400" },
          { label: "Avg Depth", value: avgDepth, icon: Layers, color: "text-violet-400" },
          { label: "Total Cost", value: formatCost(totalCost), icon: DollarSign, color: "text-emerald-400" },
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

      {/* Tree selector */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {mockTrees.map((t) => {
          const sc = statusConfig[t.status];
          return (
            <button
              key={t.id}
              onClick={() => { setSelectedTreeId(t.id); setSelectedNodeId(null); }}
              className={cn(
                "shrink-0 rounded-xl border p-3 text-left transition-all",
                selectedTreeId === t.id
                  ? "border-sky-500/40 bg-sky-500/5"
                  : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700",
              )}
              style={{ minWidth: 260 }}
            >
              <div className="flex items-center gap-2">
                <GitFork className="h-3.5 w-3.5 text-zinc-500" />
                <span className="text-xs font-semibold">{t.root.agentName}</span>
                <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", {
                  "bg-amber-500/10 text-amber-400": t.status === "working",
                  "bg-emerald-500/10 text-emerald-400": t.status === "completed",
                  "bg-red-500/10 text-red-400": t.status === "error",
                  "bg-violet-500/10 text-violet-400": t.status === "delegating",
                })}>
                  {sc.label}
                </span>
              </div>
              <p className="mt-1 truncate text-[11px] text-zinc-400">{t.label}</p>
              <div className="mt-1.5 flex items-center gap-3 text-[10px] text-zinc-500">
                <span>{t.subagentCount} agents</span>
                <span>{new Date(t.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Tree visualization */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
        <TreeNode
          node={tree.root}
          selectedId={selectedNodeId}
          onSelect={(n) => setSelectedNodeId(n.id === selectedNodeId ? null : n.id)}
          isLast
        />
      </div>

      {/* Node detail panel */}
      {selectedNode && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10">
                <Bot className="h-4 w-4 text-sky-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">{selectedNode.agentName}</p>
                <p className="text-[11px] text-zinc-500">{selectedNode.model}</p>
              </div>
            </div>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">Depth L{selectedNode.depth}</span>
          </div>

          <p className="text-xs text-zinc-300">{selectedNode.task}</p>

          {/* Cost breakdown */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Input Tokens", value: selectedNode.inputTokens.toLocaleString() },
              { label: "Output Tokens", value: selectedNode.outputTokens.toLocaleString() },
              { label: "Total Cost", value: formatCost(selectedNode.cost) },
              { label: "Messages", value: selectedNode.messageCount },
            ].map((item) => (
              <div key={item.label} className="rounded-lg bg-zinc-800/50 p-2">
                <p className="text-[10px] text-zinc-500">{item.label}</p>
                <p className="text-sm font-semibold">{item.value}</p>
              </div>
            ))}
          </div>

          {/* Tool calls */}
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-400">
              <Wrench className="h-3 w-3" /> Tool Calls
            </h3>
            <div className="space-y-1">
              {selectedNode.toolCalls.map((tc, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg bg-zinc-800/30 px-3 py-1.5">
                  <span className="font-mono text-[11px] text-zinc-300">{tc.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-500">{tc.duration}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", {
                      "bg-emerald-500/10 text-emerald-400": tc.status === "done",
                      "bg-amber-500/10 text-amber-400": tc.status === "running",
                      "bg-red-500/10 text-red-400": tc.status === "error",
                    })}>
                      {tc.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Spawn metrics */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Metrics by Depth Level</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Tokens by depth */}
          <div>
            <h3 className="mb-2 text-xs text-zinc-500">Tokens by Depth</h3>
            <div className="space-y-2">
              {depthStats.map((d) => (
                <div key={d.depth} className="flex items-center gap-2">
                  <span className="w-6 text-[10px] font-medium text-zinc-400">L{d.depth}</span>
                  <div className="flex-1 h-4 rounded bg-zinc-800">
                    <div className="h-full rounded bg-sky-500/60" style={{ width: `${(d.tokens / maxTokens) * 100}%` }} />
                  </div>
                  <span className="w-14 text-right text-[10px] text-zinc-400">{(d.tokens / 1000).toFixed(1)}K</span>
                </div>
              ))}
            </div>
          </div>
          {/* Success rate */}
          <div>
            <h3 className="mb-2 text-xs text-zinc-500">Success Rate</h3>
            <div className="space-y-2">
              {depthStats.map((d) => (
                <div key={d.depth} className="flex items-center gap-2">
                  <span className="w-6 text-[10px] font-medium text-zinc-400">L{d.depth}</span>
                  <div className="flex-1 h-4 rounded bg-zinc-800">
                    <div className={cn("h-full rounded", d.successRate >= 50 ? "bg-emerald-500/60" : "bg-red-500/60")} style={{ width: `${d.successRate}%` }} />
                  </div>
                  <span className="w-10 text-right text-[10px] text-zinc-400">{d.successRate}%</span>
                </div>
              ))}
            </div>
          </div>
          {/* Avg duration */}
          <div>
            <h3 className="mb-2 text-xs text-zinc-500">Avg Duration</h3>
            <div className="space-y-2">
              {depthStats.map((d) => {
                const maxDur = Math.max(...depthStats.map((x) => x.avgDuration), 1);
                return (
                  <div key={d.depth} className="flex items-center gap-2">
                    <span className="w-6 text-[10px] font-medium text-zinc-400">L{d.depth}</span>
                    <div className="flex-1 h-4 rounded bg-zinc-800">
                      <div className="h-full rounded bg-amber-500/60" style={{ width: `${(d.avgDuration / maxDur) * 100}%` }} />
                    </div>
                    <span className="w-10 text-right text-[10px] text-zinc-400">{formatDuration(d.avgDuration)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
