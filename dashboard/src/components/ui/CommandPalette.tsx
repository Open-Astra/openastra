import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  LayoutDashboard,
  MessageSquare,
  Bot,
  History,
  Brain,
  CalendarClock,
  Server,
  Settings,
  Search,
  Workflow,
  ShieldAlert,
  GitBranch,
  FileText,
  TriangleAlert,
  Zap,
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

const pages = [
  { to: "/", icon: LayoutDashboard, label: "Overview Dashboard", group: "Pages" },
  { to: "/chat", icon: MessageSquare, label: "Chat / Playground", group: "Pages" },
  { to: "/agents", icon: Bot, label: "Agents & Swarms", group: "Pages" },
  { to: "/agents/compare", icon: GitCompareArrows, label: "Agent Comparison", group: "Pages" },
  { to: "/sessions", icon: History, label: "Sessions & History", group: "Pages" },
  { to: "/activity", icon: GanttChart, label: "Activity Timeline", group: "Pages" },
  { to: "/steering", icon: Navigation, label: "Live Agent Steering", group: "Pages" },
  { to: "/skills", icon: Sparkles, label: "Skill Evolution", group: "Pages" },
  { to: "/spawns", icon: GitFork, label: "Subagent Spawns", group: "Pages" },
  { to: "/model-router", icon: Cpu, label: "Model Router", group: "Pages" },
  { to: "/playground", icon: FlaskConical, label: "Prompt Playground", group: "Pages" },
  { to: "/memory-graph", icon: Share2, label: "Memory Graph", group: "Pages" },
  { to: "/token-heatmap", icon: Flame, label: "Token Heatmap", group: "Pages" },
  { to: "/audit-log", icon: ScrollText, label: "Audit Log", group: "Pages" },
  { to: "/live-feed", icon: Radio, label: "Live Feed", group: "Pages" },
  { to: "/guardrails", icon: ShieldCheck, label: "Guardrails", group: "Pages" },
  { to: "/user-profile", icon: UserCircle, label: "User Profile", group: "Pages" },
  { to: "/agent-wizard", icon: Wand2, label: "Agent Wizard", group: "Pages" },
  { to: "/ops-console", icon: Activity, label: "Operations Console", group: "Pages" },
  { to: "/approval-queue", icon: Shield, label: "Approval Queue", group: "Pages" },
  { to: "/audit-viewer", icon: FileText, label: "Audit Trail Viewer", group: "Pages" },
  { to: "/billing", icon: Receipt, label: "Billing & Outcomes", group: "Pages" },
  { to: "/skill-marketplace", icon: Store, label: "Skill Marketplace", group: "Pages" },
  { to: "/memory", icon: Brain, label: "Memory Explorer", group: "Pages" },
  { to: "/costs", icon: DollarSign, label: "Cost Analytics", group: "Pages" },
  { to: "/schedules", icon: CalendarClock, label: "Scheduled Tasks", group: "Pages" },
  { to: "/webhooks", icon: Webhook, label: "Webhook Logs", group: "Pages" },
  { to: "/system", icon: Server, label: "System & Monitoring", group: "Pages" },
  { to: "/settings", icon: Settings, label: "Settings", group: "Pages" },
  { to: "/skills", icon: Workflow, label: "Skills Graph", group: "Operations" },
  { to: "/approvals", icon: ShieldAlert, label: "Approvals", group: "Operations" },
  { to: "/pipelines", icon: GitBranch, label: "Tool Pipelines", group: "Operations" },
  { to: "/prompt-versions", icon: FileText, label: "Prompt Versions", group: "Operations" },
  { to: "/alerts", icon: TriangleAlert, label: "Anomaly Alerts", group: "Operations" },
];

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, fastMode, toggleFastMode } = useAppStore();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setCommandPaletteOpen(false)}
      />

      {/* Palette */}
      <Command
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") setCommandPaletteOpen(false);
        }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          <Command.Input
            placeholder="Search pages, commands..."
            className="h-12 w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="px-4 py-8 text-center text-sm text-zinc-500">
            No results found.
          </Command.Empty>
          {["Pages", "Operations"].map((group) => (
            <Command.Group
              key={group}
              heading={group}
              className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {pages
                .filter((page) => page.group === group)
                .map((page) => (
                  <Command.Item
                    key={page.to}
                    value={page.label}
                    onSelect={() => {
                      navigate(page.to);
                      setCommandPaletteOpen(false);
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-300 aria-selected:bg-zinc-800 aria-selected:text-white"
                  >
                    <page.icon className="h-4 w-4 text-zinc-500" />
                    {page.label}
                  </Command.Item>
                ))}
            </Command.Group>
          ))}
          <Command.Group
            heading="Commands"
            className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            <Command.Item
              value="/fast toggle fast mode speed"
              onSelect={() => {
                toggleFastMode();
                setCommandPaletteOpen(false);
              }}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-300 aria-selected:bg-zinc-800 aria-selected:text-white"
            >
              <Zap className={cn("h-4 w-4", fastMode ? "fill-amber-400 text-amber-400" : "text-zinc-500")} />
              <span>/fast</span>
              <span className="ml-auto text-[10px] text-zinc-600">
                {fastMode ? "ON" : "OFF"}
              </span>
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
