import { useState } from "react";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface OutcomeMetric {
  type: string;
  label: string;
  count: number;
  included: number;
  charge: number;
  trend: "up" | "down" | "flat";
}

interface InvoiceRow {
  id: string;
  period: string;
  total: number;
  status: "paid" | "issued" | "draft";
  paidAt?: string;
}

const mockOutcomes: OutcomeMetric[] = [
  { type: "cost_saved", label: "Cloud Cost Saved", count: 2340, included: 5000, charge: 0, trend: "up" },
  { type: "drift_remediated", label: "Drift Remediated", count: 18, included: 25, charge: 0, trend: "up" },
  { type: "seo_issue_fixed", label: "SEO Issues Fixed", count: 187, included: 250, charge: 0, trend: "up" },
  { type: "ranking_improvement", label: "Rankings Improved", count: 34, included: 100, charge: 0, trend: "flat" },
  { type: "incident_prevented", label: "Incidents Prevented", count: 7, included: 10, charge: 0, trend: "down" },
  { type: "workflow_executed", label: "Workflows Executed", count: 89, included: 150, charge: 0, trend: "up" },
];

const mockInvoices: InvoiceRow[] = [
  { id: "inv-2026-05", period: "May 2026", total: 499.00, status: "draft" },
  { id: "inv-2026-04", period: "April 2026", total: 523.40, status: "paid", paidAt: "2026-04-28" },
  { id: "inv-2026-03", period: "March 2026", total: 487.20, status: "paid", paidAt: "2026-03-29" },
  { id: "inv-2026-02", period: "February 2026", total: 512.80, status: "paid", paidAt: "2026-02-27" },
  { id: "inv-2026-01", period: "January 2026", total: 499.00, status: "paid", paidAt: "2026-01-30" },
];

const currentPlan = {
  name: "Growth",
  baseFee: 499,
  period: "monthly",
};

export default function BillingDashboardPage() {
  const [tab, setTab] = useState<"overview" | "invoices">("overview");

  const totalOutcomeCharge = mockOutcomes.reduce((s, o) => s + o.charge, 0);
  const projectedTotal = currentPlan.baseFee + totalOutcomeCharge;
  const totalSaved = mockOutcomes.find((o) => o.type === "cost_saved")?.count ?? 0;
  const roi = totalSaved > 0 ? Math.round((totalSaved / projectedTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Billing & Outcomes</h1>
          <p className="text-sm text-zinc-400 mt-1">Outcome-based pricing — pay for results, not tokens</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-300 text-xs font-medium">
            {currentPlan.name} Plan
          </span>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-zinc-500" />
            <span className="text-xs text-zinc-500">Current Month</span>
          </div>
          <span className="text-2xl font-bold text-zinc-100">${projectedTotal.toFixed(0)}</span>
          <span className="text-xs text-zinc-500 block mt-0.5">base ${currentPlan.baseFee} + outcomes ${totalOutcomeCharge.toFixed(0)}</span>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <Target className="w-4 h-4 text-emerald-400" />
            <span className="text-xs text-zinc-500">Value Delivered</span>
          </div>
          <span className="text-2xl font-bold text-emerald-400">${totalSaved.toLocaleString()}</span>
          <span className="text-xs text-zinc-500 block mt-0.5">identified cost savings</span>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-4 h-4 text-sky-400" />
            <span className="text-xs text-zinc-500">ROI</span>
          </div>
          <span className="text-2xl font-bold text-sky-400">{roi}x</span>
          <span className="text-xs text-zinc-500 block mt-0.5">value / cost ratio</span>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-zinc-500">Total Outcomes</span>
          </div>
          <span className="text-2xl font-bold text-zinc-100">{mockOutcomes.reduce((s, o) => s + o.count, 0).toLocaleString()}</span>
          <span className="text-xs text-zinc-500 block mt-0.5">this billing period</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {(["overview", "invoices"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
              tab === t ? "text-zinc-100 border-sky-500" : "text-zinc-500 border-transparent hover:text-zinc-300",
            )}
          >
            {t === "overview" ? "Outcome Usage" : "Invoices"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          {/* Outcome Usage Bars */}
          {mockOutcomes.map((outcome) => {
            const usagePercent = Math.min(100, (outcome.count / outcome.included) * 100);
            const isOver = outcome.count > outcome.included;
            return (
              <div key={outcome.type} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">{outcome.label}</span>
                    {outcome.trend === "up" && <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
                    {outcome.trend === "down" && <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                  </div>
                  <div className="text-right">
                    <span className={cn("text-sm font-mono", isOver ? "text-amber-400" : "text-zinc-300")}>
                      {outcome.count.toLocaleString()}
                    </span>
                    <span className="text-xs text-zinc-600"> / {outcome.included.toLocaleString()} included</span>
                  </div>
                </div>
                <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={cn("h-full rounded-full transition-all", isOver ? "bg-amber-500" : "bg-sky-500")}
                    style={{ width: `${Math.min(usagePercent, 100)}%` }}
                  />
                </div>
                {isOver && (
                  <div className="mt-1 text-xs text-amber-400">
                    {outcome.count - outcome.included} over included — overage charge applies
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "invoices" && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Period</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Total</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Paid</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {mockInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-zinc-800/30">
                  <td className="px-4 py-3 text-sm text-zinc-200">{inv.period}</td>
                  <td className="px-4 py-3 text-sm font-mono text-zinc-200">${inv.total.toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "px-2 py-0.5 rounded text-xs font-medium",
                      inv.status === "paid" ? "bg-emerald-400/10 text-emerald-400" : inv.status === "issued" ? "bg-amber-400/10 text-amber-400" : "bg-zinc-700 text-zinc-400",
                    )}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-500">{inv.paidAt ?? "—"}</td>
                  <td className="px-4 py-3">
                    <button className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200" title="Download">
                      <Download className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
