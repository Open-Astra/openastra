import type { ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { DEMO_MODE } from "@/lib/demo";

/**
 * Wraps views that are not wired to the gateway yet and render sample data
 * only. In demo mode (dev server, or VITE_DEMO_MODE=true) the view renders;
 * in a normal production build it is replaced by an explicit placeholder so
 * sample data can never be mistaken for live data.
 */
export function DemoOnly({ children }: { children: ReactNode }) {
  if (DEMO_MODE) return <>{children}</>;

  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800/60">
        <FlaskConical className="h-6 w-6 text-zinc-400" />
      </div>
      <h2 className="text-sm font-semibold text-zinc-200">Not connected yet</h2>
      <p className="max-w-sm text-xs text-zinc-500">
        This view is a preview that is not wired to the gateway API, so it has
        no live data to show. Build the dashboard with{" "}
        <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">VITE_DEMO_MODE=true</code>{" "}
        to explore it with sample data.
      </p>
    </div>
  );
}

/** Persistent banner shown whenever sample data may be on screen. */
export function DemoBanner() {
  if (!DEMO_MODE) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300"
    >
      <FlaskConical className="h-3 w-3" />
      Demo mode — some views show sample data, not live gateway data.
    </div>
  );
}
