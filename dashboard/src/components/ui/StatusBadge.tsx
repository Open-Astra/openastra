import { cn, getStatusDot } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-300",
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", getStatusDot(status))} />
      {status}
    </span>
  );
}
