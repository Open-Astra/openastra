import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "idle":
    case "completed":
    case "healthy":
    case "ok":
    case "approved":
    case "low":
      return "text-emerald-400";
    case "busy":
    case "active":
    case "running":
    case "pending":
      return "text-sky-400";
    case "error":
    case "down":
    case "rejected":
    case "expired":
    case "critical":
      return "text-red-400";
    case "degraded":
    case "timeout":
    case "high":
    case "medium":
      return "text-amber-400";
    default:
      return "text-zinc-400";
  }
}

export function getStatusDot(status: string): string {
  switch (status) {
    case "idle":
    case "completed":
    case "healthy":
    case "ok":
    case "approved":
    case "low":
      return "bg-emerald-400";
    case "busy":
    case "active":
    case "running":
    case "pending":
      return "bg-sky-400";
    case "error":
    case "down":
    case "rejected":
    case "expired":
    case "critical":
      return "bg-red-400";
    case "degraded":
    case "timeout":
    case "high":
    case "medium":
      return "bg-amber-400";
    default:
      return "bg-zinc-500";
  }
}
