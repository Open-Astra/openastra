import { useState } from "react";
import {
  Webhook,
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Search,
  Filter,
} from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";

interface WebhookLog {
  id: string;
  direction: "incoming" | "outgoing";
  method: "POST" | "GET" | "PUT" | "PATCH";
  url: string;
  statusCode: number;
  timestamp: string;
  duration: number;
  headers: Record<string, string>;
  requestBody: Record<string, unknown>;
  responseBody: Record<string, unknown>;
  retryCount: number;
}

const mockWebhookLogs: WebhookLog[] = [
  {
    id: "wh-001",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/agent-complete",
    statusCode: 200,
    timestamp: "2026-03-14T10:23:45Z",
    duration: 142,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_abc123", "X-Request-ID": "req-9a1b2c3d" },
    requestBody: { event: "agent.complete", agentId: "agt-001", status: "success", output: { summary: "Task completed successfully" } },
    responseBody: { received: true, processedAt: "2026-03-14T10:23:45Z" },
    retryCount: 0,
  },
  {
    id: "wh-002",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/slack",
    statusCode: 200,
    timestamp: "2026-03-14T10:21:12Z",
    duration: 230,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer xoxb-slack-token", "X-Request-ID": "req-4e5f6a7b" },
    requestBody: { channel: "#alerts", text: "Agent run completed", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Agent Run Complete*" } }] },
    responseBody: { ok: true, channel: "C01ABC", ts: "1710410472.001200" },
    retryCount: 0,
  },
  {
    id: "wh-003",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/error",
    statusCode: 500,
    timestamp: "2026-03-14T10:18:33Z",
    duration: 45,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_abc123", "X-Request-ID": "req-8c9d0e1f" },
    requestBody: { event: "agent.error", agentId: "agt-003", error: { code: "TIMEOUT", message: "Agent execution timed out after 30s" } },
    responseBody: { error: "Internal server error", details: "Failed to process webhook payload" },
    retryCount: 2,
  },
  {
    id: "wh-004",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/telegram",
    statusCode: 201,
    timestamp: "2026-03-14T10:15:07Z",
    duration: 310,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-2a3b4c5d" },
    requestBody: { chat_id: 123456789, text: "Pipeline finished: 3 tasks completed", parse_mode: "Markdown" },
    responseBody: { ok: true, result: { message_id: 4521 } },
    retryCount: 0,
  },
  {
    id: "wh-005",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/agent-complete",
    statusCode: 200,
    timestamp: "2026-03-14T10:12:55Z",
    duration: 98,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_abc123", "X-Request-ID": "req-6e7f8a9b" },
    requestBody: { event: "agent.complete", agentId: "agt-005", status: "success", output: { tokens: 1520, cost: 0.0032 } },
    responseBody: { received: true, processedAt: "2026-03-14T10:12:55Z" },
    retryCount: 0,
  },
  {
    id: "wh-006",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/slack",
    statusCode: 400,
    timestamp: "2026-03-14T10:10:22Z",
    duration: 180,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer xoxb-slack-token", "X-Request-ID": "req-0c1d2e3f" },
    requestBody: { channel: "#alerts", text: "", blocks: [] },
    responseBody: { ok: false, error: "no_text", details: "Message body cannot be empty" },
    retryCount: 1,
  },
  {
    id: "wh-007",
    direction: "incoming",
    method: "GET",
    url: "/webhooks/agent-complete?verify=true",
    statusCode: 200,
    timestamp: "2026-03-14T10:08:10Z",
    duration: 12,
    headers: { "X-Webhook-Secret": "whsec_abc123", "X-Request-ID": "req-4a5b6c7d" },
    requestBody: {},
    responseBody: { status: "active", verified: true },
    retryCount: 0,
  },
  {
    id: "wh-008",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/telegram",
    statusCode: 500,
    timestamp: "2026-03-14T10:05:44Z",
    duration: 5021,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-8e9f0a1b" },
    requestBody: { chat_id: 987654321, text: "Error alert: memory threshold exceeded" },
    responseBody: { ok: false, description: "Internal Server Error" },
    retryCount: 3,
  },
  {
    id: "wh-009",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/error",
    statusCode: 400,
    timestamp: "2026-03-14T09:58:30Z",
    duration: 33,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-2c3d4e5f" },
    requestBody: { event: "invalid.event", data: null },
    responseBody: { error: "Bad Request", details: "Unknown event type: invalid.event" },
    retryCount: 0,
  },
  {
    id: "wh-010",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/slack",
    statusCode: 200,
    timestamp: "2026-03-14T09:55:18Z",
    duration: 195,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer xoxb-slack-token", "X-Request-ID": "req-6a7b8c9d" },
    requestBody: { channel: "#ops", text: "Daily digest: 42 agents ran, 39 succeeded, 3 failed" },
    responseBody: { ok: true, channel: "C02XYZ", ts: "1710408918.003400" },
    retryCount: 0,
  },
  {
    id: "wh-011",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/agent-complete",
    statusCode: 200,
    timestamp: "2026-03-14T09:50:02Z",
    duration: 110,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_def456", "X-Request-ID": "req-0e1f2a3b" },
    requestBody: { event: "agent.complete", agentId: "agt-011", status: "success", output: { records: 150 } },
    responseBody: { received: true, processedAt: "2026-03-14T09:50:02Z" },
    retryCount: 0,
  },
  {
    id: "wh-012",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/telegram",
    statusCode: 200,
    timestamp: "2026-03-14T09:45:39Z",
    duration: 275,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-4c5d6e7f" },
    requestBody: { chat_id: 123456789, text: "Scheduled report generated", document: { url: "https://storage.example.com/report.pdf" } },
    responseBody: { ok: true, result: { message_id: 4519 } },
    retryCount: 0,
  },
  {
    id: "wh-013",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/error",
    statusCode: 500,
    timestamp: "2026-03-14T09:40:11Z",
    duration: 62,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_abc123", "X-Request-ID": "req-8a9b0c1d" },
    requestBody: { event: "agent.error", agentId: "agt-007", error: { code: "RATE_LIMIT", message: "API rate limit exceeded" } },
    responseBody: { error: "Internal server error", details: "Handler threw an exception" },
    retryCount: 1,
  },
  {
    id: "wh-014",
    direction: "outgoing",
    method: "POST",
    url: "/callbacks/slack",
    statusCode: 200,
    timestamp: "2026-03-14T09:35:56Z",
    duration: 205,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer xoxb-slack-token", "X-Request-ID": "req-2e3f4a5b" },
    requestBody: { channel: "#alerts", text: "Agent agt-007 rate limited, retrying in 60s" },
    responseBody: { ok: true, channel: "C01ABC", ts: "1710407756.005600" },
    retryCount: 0,
  },
  {
    id: "wh-015",
    direction: "incoming",
    method: "POST",
    url: "/webhooks/agent-complete",
    statusCode: 201,
    timestamp: "2026-03-14T09:30:28Z",
    duration: 156,
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": "whsec_def456", "X-Request-ID": "req-6c7d8e9f" },
    requestBody: { event: "agent.complete", agentId: "agt-012", status: "success", output: { summary: "Data sync completed", rowsProcessed: 8420 } },
    responseBody: { received: true, created: true, processedAt: "2026-03-14T09:30:28Z" },
    retryCount: 0,
  },
];

function statusColor(code: number): string {
  if (code >= 200 && code < 300) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (code >= 400 && code < 500) return "text-amber-400 bg-amber-400/10 border-amber-400/20";
  return "text-red-400 bg-red-400/10 border-red-400/20";
}

function statusDot(code: number): string {
  if (code >= 200 && code < 300) return "bg-emerald-400";
  if (code >= 400 && code < 500) return "bg-amber-400";
  return "bg-red-400";
}

export function WebhooksPage() {
  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState<"all" | "incoming" | "outgoing">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const logs = mockWebhookLogs;

  const filtered = logs.filter((log) => {
    const matchesSearch =
      !search ||
      log.url.toLowerCase().includes(search.toLowerCase()) ||
      log.method.toLowerCase().includes(search.toLowerCase()) ||
      String(log.statusCode).includes(search);
    const matchesDirection = directionFilter === "all" || log.direction === directionFilter;
    return matchesSearch && matchesDirection;
  });

  const totalRequests = logs.length;
  const successCount = logs.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length;
  const successRate = totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : "0";
  const avgLatency = totalRequests > 0 ? Math.round(logs.reduce((sum, l) => sum + l.duration, 0) / totalRequests) : 0;
  const failureCount = logs.filter((l) => l.statusCode >= 400).length;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Stats Bar */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Requests", value: totalRequests, sub: "last 24h", icon: Webhook, color: "text-blue-400" },
          { label: "Success Rate", value: `${successRate}%`, sub: `${successCount} succeeded`, icon: CheckCircle2, color: "text-emerald-400" },
          { label: "Avg Latency", value: `${avgLatency}ms`, sub: "across all hooks", icon: Clock, color: "text-amber-400" },
          { label: "Failures", value: failureCount, sub: "last 24h", icon: XCircle, color: "text-red-400" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4"
          >
            <div className={cn("rounded-lg bg-zinc-800 p-2.5", stat.color)}>
              <stat.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-semibold text-zinc-100">{stat.value}</p>
              <p className="text-sm text-zinc-500">{stat.label}</p>
              <p className="text-xs text-zinc-600">{stat.sub}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Webhook className="h-5 w-5 text-zinc-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Webhook Logs</h1>
          <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
            {filtered.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search by URL, method, status..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-72 rounded-lg border border-zinc-800 bg-zinc-900 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-zinc-700"
            />
          </div>
          {/* Direction Filter */}
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
            <Filter className="ml-2 h-3.5 w-3.5 text-zinc-500" />
            {(["all", "incoming", "outgoing"] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => setDirectionFilter(dir)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors",
                  directionFilter === dir
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {dir}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Log List */}
      <div className="flex flex-col gap-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 py-16">
            <Webhook className="h-10 w-10 text-zinc-700" />
            <p className="text-sm text-zinc-500">No webhook logs match your filters</p>
          </div>
        ) : (
          filtered.map((log) => {
            const isExpanded = expandedId === log.id;
            return (
              <div key={log.id} className="rounded-lg border border-zinc-800 bg-zinc-900">
                {/* Row */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-zinc-800/50"
                >
                  {/* Expand icon */}
                  <div className="text-zinc-600">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </div>

                  {/* Direction */}
                  <div
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
                      log.direction === "incoming"
                        ? "border-blue-400/20 bg-blue-400/10 text-blue-400"
                        : "border-purple-400/20 bg-purple-400/10 text-purple-400"
                    )}
                  >
                    {log.direction === "incoming" ? (
                      <ArrowDownLeft className="h-3 w-3" />
                    ) : (
                      <ArrowUpRight className="h-3 w-3" />
                    )}
                    {log.direction}
                  </div>

                  {/* Method */}
                  <span className="w-14 rounded bg-zinc-800 px-2 py-0.5 text-center text-xs font-mono font-semibold text-zinc-300">
                    {log.method}
                  </span>

                  {/* URL */}
                  <span className="flex-1 truncate font-mono text-sm text-zinc-300">
                    {log.url}
                  </span>

                  {/* Status Code */}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      statusColor(log.statusCode)
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(log.statusCode))} />
                    {log.statusCode}
                  </span>

                  {/* Duration */}
                  <span className="flex items-center gap-1 text-xs text-zinc-500">
                    <Clock className="h-3 w-3" />
                    {log.duration}ms
                  </span>

                  {/* Timestamp */}
                  <span className="w-24 text-right text-xs text-zinc-600">
                    {formatRelativeTime(log.timestamp)}
                  </span>
                </button>

                {/* Expanded Detail */}
                <div
                  className={cn(
                    "overflow-hidden transition-all duration-200",
                    isExpanded ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
                  )}
                >
                  <div className="border-t border-zinc-800 px-6 py-4">
                    <div className="grid grid-cols-2 gap-6">
                      {/* Headers */}
                      <div>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                          Headers
                        </h3>
                        <table className="w-full text-sm">
                          <tbody>
                            {Object.entries(log.headers).map(([key, value]) => (
                              <tr key={key} className="border-b border-zinc-800/50 last:border-0">
                                <td className="py-1.5 pr-4 font-mono text-xs font-medium text-zinc-400">
                                  {key}
                                </td>
                                <td className="py-1.5 font-mono text-xs text-zinc-500">
                                  {value}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Retry Count */}
                      <div className="flex items-start justify-end">
                        <div
                          className={cn(
                            "rounded-lg border px-3 py-2 text-xs",
                            log.retryCount > 0
                              ? "border-amber-400/20 bg-amber-400/10 text-amber-400"
                              : "border-zinc-800 bg-zinc-950 text-zinc-500"
                          )}
                        >
                          Retries: <span className="font-semibold">{log.retryCount}</span>
                        </div>
                      </div>

                      {/* Request Body */}
                      <div>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                          Request Body
                        </h3>
                        <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
                          {JSON.stringify(log.requestBody, null, 2)}
                        </pre>
                      </div>

                      {/* Response Body */}
                      <div>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                          Response Body
                        </h3>
                        <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
                          {JSON.stringify(log.responseBody, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
