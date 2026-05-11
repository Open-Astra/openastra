import { useState } from "react";
import {
  FileText,
  Download,
  ShieldCheck,
  Search,
  CheckCircle2,
  Hash,
} from "lucide-react";
import { cn } from "@/lib/utils";

type RiskLevel = "info" | "low" | "medium" | "high" | "critical";

interface AuditEntry {
  id: string;
  sequence: number;
  action: string;
  category: string;
  description: string;
  riskLevel: RiskLevel;
  uid: string;
  agentId?: string;
  entryHash: string;
  previousHash: string;
  chainValid: boolean;
  createdAt: string;
}

const now = Date.now();
const min = 60_000;

const mockEntries: AuditEntry[] = [
  { id: "aud-001", sequence: 1047, action: "approval.granted", category: "governance", description: "Approved: terminate idle instance i-0abc123", riskLevel: "high", uid: "admin@ops.io", agentId: "cloud-health", entryHash: "a3f2c1...", previousHash: "9e8d7c...", chainValid: true, createdAt: new Date(now - 2 * min).toISOString() },
  { id: "aud-002", sequence: 1046, action: "skill.execute", category: "operations", description: "Executed cloud_drift_detect on production stack", riskLevel: "medium", uid: "system", agentId: "cloud-health", entryHash: "9e8d7c...", previousHash: "b4a5d6...", chainValid: true, createdAt: new Date(now - 5 * min).toISOString() },
  { id: "aud-003", sequence: 1045, action: "data.write", category: "data", description: "Updated meta descriptions on 12 product pages", riskLevel: "low", uid: "system", agentId: "seo-ops", entryHash: "b4a5d6...", previousHash: "c7f8e9...", chainValid: true, createdAt: new Date(now - 8 * min).toISOString() },
  { id: "aud-004", sequence: 1044, action: "workflow.completed", category: "execution", description: "Completed: Weekly SEO Audit (7 steps, 12m)", riskLevel: "info", uid: "system", agentId: "seo-ops", entryHash: "c7f8e9...", previousHash: "d2e3f4...", chainValid: true, createdAt: new Date(now - 14 * min).toISOString() },
  { id: "aud-005", sequence: 1043, action: "auth.login", category: "access", description: "User login from 192.168.1.42 (MFA verified)", riskLevel: "info", uid: "admin@ops.io", entryHash: "d2e3f4...", previousHash: "e5f6a7...", chainValid: true, createdAt: new Date(now - 30 * min).toISOString() },
  { id: "aud-006", sequence: 1042, action: "config.changed", category: "governance", description: "Updated egress policy: added api.stripe.com to allowlist", riskLevel: "medium", uid: "admin@ops.io", entryHash: "e5f6a7...", previousHash: "f8a9b0...", chainValid: true, createdAt: new Date(now - 45 * min).toISOString() },
  { id: "aud-007", sequence: 1041, action: "system.security_event", category: "security", description: "DLP blocked egress: API key detected in payload to external webhook", riskLevel: "critical", uid: "system", agentId: "cloud-health", entryHash: "f8a9b0...", previousHash: "01c2d3...", chainValid: true, createdAt: new Date(now - 60 * min).toISOString() },
  { id: "aud-008", sequence: 1040, action: "billing.charge", category: "billing", description: "Outcome recorded: $45 cost savings identified (drift remediation)", riskLevel: "info", uid: "system", agentId: "cloud-health", entryHash: "01c2d3...", previousHash: "genesis", chainValid: true, createdAt: new Date(now - 90 * min).toISOString() },
];

const riskBadge: Record<RiskLevel, { bg: string; text: string }> = {
  info: { bg: "bg-zinc-700/50", text: "text-zinc-400" },
  low: { bg: "bg-emerald-400/10", text: "text-emerald-400" },
  medium: { bg: "bg-amber-400/10", text: "text-amber-400" },
  high: { bg: "bg-orange-400/10", text: "text-orange-400" },
  critical: { bg: "bg-red-400/10", text: "text-red-400" },
};

export default function AuditViewerPage() {
  const [search, setSearch] = useState("");
  const [verificationStatus] = useState<"verified" | "checking" | null>("verified");

  const filtered = search
    ? mockEntries.filter((e) => e.description.toLowerCase().includes(search.toLowerCase()) || e.action.includes(search.toLowerCase()))
    : mockEntries;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Audit Trail</h1>
          <p className="text-sm text-zinc-400 mt-1">Tamper-evident, hash-chained audit log for compliance</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> Verify Chain
          </button>
          <button className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      {/* Chain Verification Banner */}
      {verificationStatus === "verified" && (
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          <div>
            <span className="text-sm font-medium text-emerald-300">Chain integrity verified</span>
            <span className="text-xs text-emerald-400/60 ml-2">1,047 entries · Last verified 2m ago · No gaps detected</span>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search audit entries..."
          className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
        />
      </div>

      {/* Entries */}
      <div className="space-y-1">
        {filtered.map((entry, idx) => (
          <div key={entry.id} className="group relative">
            {/* Chain Link Indicator */}
            {idx < filtered.length - 1 && (
              <div className="absolute left-[19px] top-10 bottom-0 w-px bg-zinc-800 group-hover:bg-zinc-700" />
            )}

            <div className="flex gap-3 p-3 rounded-lg hover:bg-zinc-900/50 transition-colors">
              {/* Chain dot */}
              <div className="relative flex-shrink-0 mt-1">
                <div className={cn(
                  "w-2.5 h-2.5 rounded-full border-2",
                  entry.chainValid ? "border-emerald-500 bg-emerald-500/30" : "border-red-500 bg-red-500/30",
                )} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", riskBadge[entry.riskLevel].bg, riskBadge[entry.riskLevel].text)}>
                    {entry.riskLevel}
                  </span>
                  <span className="text-sm text-zinc-200">{entry.description}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
                  <span className="font-mono">{entry.action}</span>
                  <span>{entry.uid}</span>
                  {entry.agentId && <span className="text-sky-500/70">{entry.agentId}</span>}
                  <span className="flex items-center gap-0.5"><Hash className="w-3 h-3" />{entry.sequence}</span>
                </div>
              </div>

              {/* Time + Hash */}
              <div className="flex-shrink-0 text-right">
                <div className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleTimeString()}</div>
                <div className="text-[10px] font-mono text-zinc-700 mt-0.5">{entry.entryHash}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No audit entries match your search</p>
        </div>
      )}
    </div>
  );
}
