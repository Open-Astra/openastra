import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  MessageSquare,
  Bot,
  History,
  Brain,
  CalendarClock,
  Server,
  Settings,
  MoreHorizontal,
  X,
  DollarSign,
  Webhook,
  GitCompareArrows,
  GanttChart,
  Navigation,
  Sparkles,
  GitFork,
  Cpu,
  FlaskConical,
  Share2,
  Flame,
  ScrollText,
  Radio,
  ShieldCheck,
  UserCircle,
  Wand2,
  Activity,
  Shield,
  FileText,
  Receipt,
  Store,
  Workflow,
  ShieldAlert,
  GitBranch,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

const primaryItems = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/sessions", icon: History, label: "Sessions" },
];

const moreItems = [
  { to: "/agents/compare", icon: GitCompareArrows, label: "Compare" },
  { to: "/activity", icon: GanttChart, label: "Timeline" },
  { to: "/steering", icon: Navigation, label: "Steering" },
  { to: "/skills", icon: Sparkles, label: "Skills" },
  { to: "/spawns", icon: GitFork, label: "Spawns" },
  { to: "/model-router", icon: Cpu, label: "Router" },
  { to: "/playground", icon: FlaskConical, label: "Playground" },
  { to: "/memory-graph", icon: Share2, label: "Graph" },
  { to: "/token-heatmap", icon: Flame, label: "Heatmap" },
  { to: "/live-feed", icon: Radio, label: "Live Feed" },
  { to: "/guardrails", icon: ShieldCheck, label: "Guardrails" },
  { to: "/agent-wizard", icon: Wand2, label: "Wizard" },
  { to: "/ops-console", icon: Activity, label: "Ops Console" },
  { to: "/approval-queue", icon: Shield, label: "Approvals" },
  { to: "/audit-viewer", icon: FileText, label: "Audit Trail" },
  { to: "/billing", icon: Receipt, label: "Billing" },
  { to: "/skill-marketplace", icon: Store, label: "Marketplace" },
  { to: "/approvals", icon: ShieldAlert, label: "Approvals" },
  { to: "/pipelines", icon: GitBranch, label: "Pipelines" },
  { to: "/prompt-versions", icon: Workflow, label: "Prompts" },
  { to: "/alerts", icon: TriangleAlert, label: "Alerts" },
  { to: "/audit-log", icon: ScrollText, label: "Audit" },
  { to: "/user-profile", icon: UserCircle, label: "Profile" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/costs", icon: DollarSign, label: "Costs" },
  { to: "/schedules", icon: CalendarClock, label: "Schedules" },
  { to: "/webhooks", icon: Webhook, label: "Webhooks" },
  { to: "/system", icon: Server, label: "System" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function MobileNav() {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      {/* More menu overlay */}
      {moreOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div className="absolute inset-x-0 bottom-[57px] p-3">
            <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-2xl">
              <div className="mb-2 flex items-center justify-between px-2 pt-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  More
                </span>
                <button
                  onClick={() => setMoreOpen(false)}
                  className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {moreItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-[10px] font-medium transition-colors",
                        isActive
                          ? "bg-sky-500/10 text-sky-400"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
                      )
                    }
                  >
                    <item.icon className="h-5 w-5" />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur-sm safe-bottom">
        <div className="flex items-center justify-around py-2">
          {primaryItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-sky-400"
                    : "text-zinc-500 hover:text-zinc-300",
                )
              }
            >
              <item.icon className="h-5 w-5" />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-lg px-3 py-1 text-[10px] font-medium transition-colors",
              moreOpen ? "text-sky-400" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span>More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
