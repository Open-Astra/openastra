import { type LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-xl bg-zinc-800/50 p-4">
        <Icon className="h-8 w-8 text-zinc-500" />
      </div>
      <h3 className="mb-1 text-sm font-semibold text-zinc-300">{title}</h3>
      <p className="mb-4 max-w-sm text-xs text-zinc-500">{description}</p>
      {action}
    </div>
  );
}
