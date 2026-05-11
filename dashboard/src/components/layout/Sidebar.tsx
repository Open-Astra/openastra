import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  MessageSquare,
  Bot,
  History,
  Brain,
  Server,
  Settings,
  ChevronLeft,
  CalendarClock,
  ChevronRight,
  Zap,
  Workflow,
  ShieldAlert,
  FileText,
  GitBranch,
  TriangleAlert,
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
  Receipt,
  Store,
} from "lucide-react";
import { useAppStore } from "@/stores/app";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/agents/compare", icon: GitCompareArrows, label: "Compare" },
  { to: "/sessions", icon: History, label: "Sessions" },
  { to: "/activity", icon: GanttChart, label: "Timeline" },
  { to: "/steering", icon: Navigation, label: "Steering" },
  { to: "/skills", icon: Sparkles, label: "Skills" },
  { to: "/spawns", icon: GitFork, label: "Spawns" },
  { to: "/model-router", icon: Cpu, label: "Model Router" },
  { to: "/playground", icon: FlaskConical, label: "Playground" },
  { to: "/memory-graph", icon: Share2, label: "Memory Graph" },
  { to: "/token-heatmap", icon: Flame, label: "Token Heatmap" },
  { to: "/live-feed", icon: Radio, label: "Live Feed" },
  { to: "/guardrails", icon: ShieldCheck, label: "Guardrails" },
  { to: "/agent-wizard", icon: Wand2, label: "Agent Wizard" },
  { to: "/ops-console", icon: Activity, label: "Ops Console" },
  { to: "/approval-queue", icon: Shield, label: "Approvals" },
  { to: "/audit-viewer", icon: FileText, label: "Audit Trail" },
  { to: "/billing", icon: Receipt, label: "Billing" },
  { to: "/skill-marketplace", icon: Store, label: "Marketplace" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/costs", icon: DollarSign, label: "Costs" },
  { to: "/schedules", icon: CalendarClock, label: "Schedules" },
  { to: "/webhooks", icon: Webhook, label: "Webhooks" },
  { to: "/audit-log", icon: ScrollText, label: "Audit Log" },
  { to: "/user-profile", icon: UserCircle, label: "User Profile" },
  { to: "/system", icon: Server, label: "System" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

const operationsItems = [
  { to: "/skills", icon: Workflow, label: "Skills Graph" },
  { to: "/approvals", icon: ShieldAlert, label: "Approvals" },
  { to: "/pipelines", icon: GitBranch, label: "Tool Pipelines" },
  { to: "/prompt-versions", icon: FileText, label: "Prompt Versions" },
  { to: "/alerts", icon: TriangleAlert, label: "Anomaly Alerts" },
];

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useAppStore();

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-zinc-800 bg-zinc-950 transition-all duration-200",
        sidebarOpen ? "w-64" : "w-16",
      )}
    >
      {/* Logo */}
      <div className="flex h-14 items-center gap-3 border-b border-zinc-800 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10">
          <Zap className="h-4 w-4 text-sky-400" />
        </div>
        {sidebarOpen && (
          <span className="text-sm font-semibold tracking-tight">
            OpenAstra
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <div className="space-y-1">
          {sidebarOpen && (
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-600">
              Core
            </p>
          )}
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
                  !sidebarOpen && "justify-center px-0",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {sidebarOpen && <span>{item.label}</span>}
            </NavLink>
          ))}
        </div>

        <div className="space-y-1">
          {sidebarOpen && (
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-600">
              Operations
            </p>
          )}
          {operationsItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
                  !sidebarOpen && "justify-center px-0",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {sidebarOpen && <span>{item.label}</span>}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-zinc-800 p-2">
        <button
          onClick={toggleSidebar}
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
        >
          {sidebarOpen ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
