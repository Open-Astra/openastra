import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleSlash,
  Filter,
  Search,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn, formatRelativeTime } from "@/lib/utils";
import { mockApprovals } from "@/hooks/use-mock-data";
import type { ApprovalRequest } from "@/types/api";

interface ApprovalsPayload {
  approvals: ApprovalRequest[];
  offline: boolean;
}

function updateApprovalStatus(
  items: ApprovalRequest[],
  id: string,
  status: ApprovalRequest["status"],
  reviewedBy = "local-dashboard",
): ApprovalRequest[] {
  return items.map((item) =>
    item.id === id
      ? {
          ...item,
          status,
          reviewedBy: status === "pending" ? null : reviewedBy,
          reviewedAt: status === "pending" ? null : new Date().toISOString(),
        }
      : item,
  );
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localApprovals, setLocalApprovals] = useState<ApprovalRequest[]>([]);
  const [offline, setOffline] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalsPayload> => {
      try {
        const response = await api.approvals.list();
        return { approvals: response.approvals, offline: false };
      } catch {
        return { approvals: mockApprovals, offline: true };
      }
    },
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (data) {
      setLocalApprovals(data.approvals);
      setOffline(data.offline);
    }
  }, [data]);

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.approvals.approve(id);
        return { id, status: "approved" as const, offline: false };
      } catch {
        return { id, status: "approved" as const, offline: true };
      }
    },
    onSuccess: (result) => {
      setLocalApprovals((items) => updateApprovalStatus(items, result.id, result.status));
      toast.success(result.offline ? "Approval updated locally" : "Approval granted");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.approvals.reject(id);
        return { id, status: "rejected" as const, offline: false };
      } catch {
        return { id, status: "rejected" as const, offline: true };
      }
    },
    onSuccess: (result) => {
      setLocalApprovals((items) => updateApprovalStatus(items, result.id, result.status));
      toast.success(result.offline ? "Rejection updated locally" : "Approval rejected");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  const approvals = localApprovals;

  const filtered = useMemo(() => {
    return approvals.filter((approval) => {
      const matchesSearch =
        approval.id.toLowerCase().includes(search.toLowerCase()) ||
        approval.agentId.toLowerCase().includes(search.toLowerCase()) ||
        approval.toolName.toLowerCase().includes(search.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || approval.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [approvals, search, statusFilter]);

  useEffect(() => {
    if (!selectedId && filtered[0]) {
      setSelectedId(filtered[0].id);
    }
    if (selectedId && !filtered.some((item) => item.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  const detail = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;
  const pending = approvals.filter((item) => item.status === "pending").length;
  const reviewed = approvals.filter((item) => item.status !== "pending").length;
  const expiringSoon = approvals.filter((item) => {
    const expiresAt = new Date(item.expiresAt).getTime();
    return item.status === "pending" && expiresAt - Date.now() < 3_600_000;
  }).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Approvals</h1>
          <p className="text-sm text-zinc-500">
            Review human-in-the-loop requests and keep the agent loop safe
          </p>
        </div>
        <div className="flex items-center gap-3">
          {offline && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              Fallback data
            </span>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search approvals..."
              className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-8 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="expired">Expired</option>
            </select>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="space-y-2">
                <div className="h-3 w-20 rounded bg-zinc-800" />
                <div className="h-8 w-24 rounded bg-zinc-800" />
                <div className="h-3 w-16 rounded bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Pending" value={pending} icon={TimerReset} change="Awaiting human review" />
          <StatCard title="Reviewed" value={reviewed} icon={ShieldCheck} change="Already handled" />
          <StatCard title="Expiring Soon" value={expiringSoon} icon={CircleSlash} change="Under 1 hour remaining" changeType={expiringSoon > 0 ? "negative" : "positive"} />
          <StatCard title="Offline Mode" value={offline ? "Yes" : "No"} icon={CheckCircle2} change={offline ? "Using mock approvals" : "Live API"} changeType={offline ? "neutral" : "positive"} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <span className="w-28">Request</span>
              <span className="flex-1">Tool</span>
              <span className="w-24 text-center">Agent</span>
              <span className="w-20 text-center">Status</span>
              <span className="w-28 text-right">Created</span>
            </div>

            {filtered.length > 0 ? (
              filtered.map((approval) => (
                <button
                  key={approval.id}
                  onClick={() => setSelectedId(approval.id)}
                  className={cn(
                    "flex w-full items-center gap-4 border-b border-zinc-800/50 px-4 py-3 text-left text-xs transition-colors hover:bg-zinc-800/30",
                    selectedId === approval.id && "bg-zinc-800/40",
                  )}
                >
                  <span className="w-28 truncate font-mono text-zinc-400">
                    {approval.id}
                  </span>
                  <span className="flex-1 truncate text-zinc-200">
                    {approval.toolName}
                  </span>
                  <span className="w-24 truncate text-center text-zinc-400">
                    {approval.agentId}
                  </span>
                  <span className="flex w-20 justify-center">
                    <StatusBadge status={approval.status} />
                  </span>
                  <span className="w-28 text-right text-zinc-500">
                    {formatRelativeTime(approval.createdAt)}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title="No approvals found"
                description="No approval requests match the current filters."
              />
            )}
          </div>
        </div>

        <div className="space-y-4">
          {detail ? (
            <div className="sticky top-6 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-200">Request Details</h2>
                  <p className="text-xs text-zinc-500">{detail.toolName}</p>
                </div>
                <StatusBadge status={detail.status} />
              </div>

              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Agent</span>
                  <span className="text-zinc-300">{detail.agentId}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Session</span>
                  <span className="text-zinc-300">{detail.sessionId ?? "none"}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Expires</span>
                  <span className="text-zinc-300">{formatRelativeTime(detail.expiresAt)}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Reviewed By</span>
                  <span className="text-zinc-300">{detail.reviewedBy ?? "pending"}</span>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Tool Args</p>
                  <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-300">
                    {JSON.stringify(detail.toolArgs, null, 2)}
                  </pre>
                </div>
              </div>

              {detail.status === "pending" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => approveMutation.mutate(detail.id)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Approve
                  </button>
                  <button
                    onClick={() => rejectMutation.mutate(detail.id)}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    <CircleSlash className="h-3.5 w-3.5" />
                    Reject
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-center">
              <p className="text-xs text-zinc-600">
                Select a request to review details
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
