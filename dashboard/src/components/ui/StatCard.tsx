import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MiniChart } from "./MiniChart";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  sparklineData?: number[];
  className?: string;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  change,
  changeType = "neutral",
  sparklineData,
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-500">{title}</p>
          <p className="text-2xl font-bold tracking-tight">{value}</p>
          {change && (
            <p
              className={cn(
                "text-xs font-medium",
                changeType === "positive" && "text-emerald-400",
                changeType === "negative" && "text-red-400",
                changeType === "neutral" && "text-zinc-500",
              )}
            >
              {change}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="rounded-lg bg-zinc-800/50 p-2">
            <Icon className="h-4 w-4 text-zinc-400" />
          </div>
          {sparklineData && (
            <MiniChart data={sparklineData} className="h-8 w-20" />
          )}
        </div>
      </div>
    </div>
  );
}
