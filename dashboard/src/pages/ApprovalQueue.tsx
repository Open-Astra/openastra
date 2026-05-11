import { useState } from "react";
import {
  Shield,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
  Zap,
  Bot,
  Filter,
} from "lucide-react";
import { cn } from "@/lib/utils";

type RiskLevel = "low" | "medium" | "high" | "critical";
type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "auto_approved" | "escalated";

interface Proposal {
  id: string;
  agentId: string;
  action: string;
  category: string;
  riskLevel: RiskLevel;
  description: string;
  expectedOutcome: string;
  reversible: boolean;
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  params: Record<string, unknown>;
}

const now = Date.now();
const min = 60_000;

const mockProposals: Proposal[] = [
  { id: "prop-001", agentId: "cloud-health", action: "terminate_instance", category: "infrastructure", riskLevel: "high", description: "Terminate idle EC2 instance i-0abc123 (no traffic for 14 days)", expectedOutcome: "Save $120/month", reversible: false, status: "pending", createdAt: new Date(now - 5 * min).toISOString(), expiresAt: new Date(now + 55 * min).toISOString(), params: { instanceId: "i-0abc123", region: "us-east-1" } },
  { id: "prop-002", agentId: "seo-ops", action: "publish_content", category: "user_facing", riskLevel: "medium", description: "Publish SEO-optimized blog post: 'Cloud Cost Optimization Guide 2026'", expectedOutcome: "Target keyword #3 position within 30 days", reversible: true, status: "pending", createdAt: new Date(now - 12 * min).toISOString(), expiresAt: new Date(now + 48 * min).toISOString(), params: { title: "Cloud Cost Optimization Guide 2026", wordCount: 2400 } },
  { id: "prop-003", agentId: "cloud-health", action: "update_security_group", category: "security_sensitive", riskLevel: "critical", description: "Remove public access from security group sg-prod-db (drift detected)", expectedOutcome: "Restore compliance — block unauthorized access", reversible: true, status: "escalated", createdAt: new Date(now - 30 * min).toISOString(), expiresAt: new Date(now + 30 * min).toISOString(), params: { sgId: "sg-prod-db", ruleToRemove: "0.0.0.0/0:5432" } },
  { id: "prop-004", agentId: "cloud-health", action: "resize_instance", category: "config_change", riskLevel: "medium", description: "Rightsize api-server-2 from t3.xlarge to t3.large (avg CPU 22%)", expectedOutcome: "Save $60/month with minimal performance impact", reversible: true, status: "pending", createdAt: new Date(now - 8 * min).toISOString(), expiresAt: new Date(now + 52 * min).toISOString(), params: { instanceId: "i-0def456", from: "t3.xlarge", to: "t3.large" } },
  { id: "prop-005", agentId: "seo-ops", action: "update_meta_tags", category: "data_write", riskLevel: "low", description: "Update meta descriptions on 12 product pages (missing descriptions)", expectedOutcome: "Improve CTR by estimated 15-25%", reversible: true, status: "auto_approved", createdAt: new Date(now - 45 * min).toISOString(), expiresAt: new Date(now + 15 * min).toISOString(), params: { pageCount: 12, type: "meta_description" } },
  { id: "prop-006", agentId: "cloud-health", action: "renew_certificate", category: "config_change", riskLevel: "low", description: "Renew SSL certificate for api.example.com (expires in 5 days)", expectedOutcome: "Prevent service disruption", reversible: false, status: "approved", createdAt: new Date(now - 120 * min).toISOString(), expiresAt: new Date(now - 60 * min).toISOString(), params: { domain: "api.example.com", daysUntilExpiry: 5 } },
];

const riskColors: Record<RiskLevel, string> = {
  low: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
  medium: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  high: "text-orange-400 bg-orange-400/10 border-orange-400/20",
  critical: "text-red-400 bg-red-400/10 border-red-400/20",
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

export default function ApprovalQueuePage() {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = filter === "pending"
    ? mockProposals.filter((p) => p.status === "pending" || p.status === "escalated")
    : mockProposals;

  const pendingCount = mockProposals.filter((p) => p.status === "pending" || p.status === "escalated").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Approval Queue</h1>
          <p className="text-sm text-zinc-400 mt-1">Review and approve agent-proposed actions before execution</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-full bg-violet-500/20 text-violet-300 text-xs font-medium">
            {pendingCount} pending
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-zinc-500" />
        {(["pending", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-medium transition-colors",
              filter === f ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {f === "pending" ? "Needs Review" : "All Proposals"}
          </button>
        ))}
      </div>

      {/* Proposals */}
      <div className="space-y-3">
        {filtered.map((proposal) => (
          <div
            key={proposal.id}
            className={cn(
              "bg-zinc-900 border rounded-lg overflow-hidden transition-colors",
              proposal.status === "escalated" ? "border-red-500/30" : "border-zinc-800",
            )}
          >
            <div
              className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-zinc-800/30"
              onClick={() => setExpanded(expanded === proposal.id ? null : proposal.id)}
            >
              {/* Risk Badge */}
              <span className={cn("px-2 py-0.5 rounded border text-[10px] font-bold uppercase", riskColors[proposal.riskLevel])}>
                {proposal.riskLevel}
              </span>

              {/* Main Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-200 truncate">{proposal.description}</span>
                  {proposal.status === "escalated" && (
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-zinc-500 flex items-center gap-1"><Bot className="w-3 h-3" />{proposal.agentId}</span>
                  <span className="text-xs text-zinc-600">{proposal.category}</span>
                  <span className="text-xs text-zinc-600">{timeAgo(proposal.createdAt)}</span>
                </div>
              </div>

              {/* Status / Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {(proposal.status === "pending" || proposal.status === "escalated") && (
                  <>
                    <button className="p-1.5 rounded-md bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 transition-colors" title="Approve">
                      <ThumbsUp className="w-4 h-4" />
                    </button>
                    <button className="p-1.5 rounded-md bg-red-600/20 hover:bg-red-600/40 text-red-400 transition-colors" title="Reject">
                      <ThumbsDown className="w-4 h-4" />
                    </button>
                  </>
                )}
                {proposal.status === "approved" && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                {proposal.status === "rejected" && <XCircle className="w-4 h-4 text-red-400" />}
                {proposal.status === "auto_approved" && <Zap className="w-4 h-4 text-sky-400" />}
                {proposal.status === "expired" && <Clock className="w-4 h-4 text-zinc-600" />}
                <ChevronRight className={cn("w-4 h-4 text-zinc-600 transition-transform", expanded === proposal.id && "rotate-90")} />
              </div>
            </div>

            {/* Expanded Details */}
            {expanded === proposal.id && (
              <div className="px-4 pb-4 border-t border-zinc-800/50 pt-3">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-zinc-500 text-xs">Expected Outcome</span>
                    <p className="text-zinc-300 mt-0.5">{proposal.expectedOutcome}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500 text-xs">Action</span>
                    <p className="text-zinc-300 mt-0.5 font-mono text-xs">{proposal.action}</p>
                  </div>
                  <div>
                    <span className="text-zinc-500 text-xs">Reversible</span>
                    <p className={cn("mt-0.5", proposal.reversible ? "text-emerald-400" : "text-amber-400")}>
                      {proposal.reversible ? "Yes" : "No — irreversible"}
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-500 text-xs">Expires</span>
                    <p className="text-zinc-300 mt-0.5">{new Date(proposal.expiresAt).toLocaleTimeString()}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <span className="text-zinc-500 text-xs">Parameters</span>
                  <pre className="mt-1 text-xs font-mono text-zinc-400 bg-zinc-950 rounded p-2 overflow-x-auto">
                    {JSON.stringify(proposal.params, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No proposals to review</p>
        </div>
      )}
    </div>
  );
}
