import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Command, Bell, Zap, LogOut, User, Settings, Sun, Moon, X, AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  time: string;
  read: boolean;
}

const now = Date.now();
const min = 60_000;

const mockNotifications: Notification[] = [
  { id: "n1", type: "success", title: "Agent Completed", message: "Research Agent finished 'competitor analysis' task", time: new Date(now - min * 2).toISOString(), read: false },
  { id: "n2", type: "error", title: "Rate Limit Hit", message: "Groq API rate limit exceeded — switched to fallback model", time: new Date(now - min * 15).toISOString(), read: false },
  { id: "n3", type: "info", title: "New Skill Learned", message: "Code Assistant acquired 'docker-compose generation' skill", time: new Date(now - min * 45).toISOString(), read: false },
  { id: "n4", type: "warning", title: "Token Budget Alert", message: "Daily token usage at 85% of configured limit", time: new Date(now - min * 120).toISOString(), read: true },
  { id: "n5", type: "success", title: "Scheduled Task Complete", message: "Daily metrics report generated and emailed", time: new Date(now - min * 180).toISOString(), read: true },
  { id: "n6", type: "info", title: "Model Update", message: "Claude Opus 4.6 now available in model router", time: new Date(now - min * 360).toISOString(), read: true },
];

const notifIcon: Record<string, typeof Info> = { info: Info, success: CheckCircle2, warning: AlertCircle, error: AlertCircle };
const notifColor: Record<string, string> = { info: "text-sky-400", success: "text-emerald-400", warning: "text-amber-400", error: "text-red-400" };

export function Topbar() {
  const navigate = useNavigate();
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const fastMode = useAppStore((s) => s.fastMode);
  const toggleFastMode = useAppStore((s) => s.toggleFastMode);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const notificationPanelOpen = useAppStore((s) => s.notificationPanelOpen);
  const setNotificationPanelOpen = useAppStore((s) => s.setNotificationPanelOpen);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [menuOpen, setMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState(mockNotifications);
  const menuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotificationPanelOpen(false);
      }
    };
    if (menuOpen || notificationPanelOpen) {
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [menuOpen, notificationPanelOpen, setNotificationPanelOpen]);

  const markAllRead = () => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  const dismissNotification = (id: string) => setNotifications((prev) => prev.filter((n) => n.id !== id));
  const formatTime = (iso: string) => {
    const diff = Math.floor((now - new Date(iso).getTime()) / min);
    if (diff < 1) return "just now";
    if (diff < 60) return `${diff}m ago`;
    return `${Math.floor(diff / 60)}h ago`;
  };

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const initials = user?.displayName?.[0]?.toUpperCase()
    ?? user?.email?.[0]?.toUpperCase()
    ?? "?";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-sm">
      {/* Search trigger */}
      <button
        onClick={() => setCommandPaletteOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search or command...</span>
        <kbd className="ml-2 hidden rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 sm:inline-block">
          <Command className="inline h-2.5 w-2.5" />K
        </kbd>
      </button>

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Fast mode toggle */}
        <button
          onClick={toggleFastMode}
          title={fastMode ? "Fast mode ON — faster output, same model" : "Fast mode OFF"}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all",
            fastMode
              ? "border-amber-500/30 bg-amber-500/10 text-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.15)]"
              : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400",
          )}
        >
          <Zap
            className={cn(
              "h-3.5 w-3.5 transition-colors",
              fastMode && "fill-amber-400",
            )}
          />
          <span className="hidden sm:inline">/fast</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* Notification bell */}
        <div ref={notifRef} className="relative">
          <button
            onClick={() => setNotificationPanelOpen(!notificationPanelOpen)}
            className="relative rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-sky-500 text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>
          {notificationPanelOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <span className="text-xs font-semibold text-zinc-200">Notifications</span>
                <div className="flex items-center gap-2">
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="text-[10px] text-sky-400 hover:text-sky-300">Mark all read</button>
                  )}
                  <button onClick={() => setNotificationPanelOpen(false)} className="rounded p-0.5 text-zinc-500 hover:text-zinc-300">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-zinc-600">No notifications</div>
                ) : (
                  notifications.map((n) => {
                    const NIcon = notifIcon[n.type] ?? Info;
                    return (
                      <div key={n.id} className={cn("flex items-start gap-2.5 px-4 py-3 transition-colors hover:bg-zinc-800/40", !n.read && "bg-sky-500/5")}>
                        <NIcon className={cn("mt-0.5 h-4 w-4 shrink-0", notifColor[n.type])} />
                        <div className="min-w-0 flex-1">
                          <p className={cn("text-xs font-medium", n.read ? "text-zinc-400" : "text-zinc-200")}>{n.title}</p>
                          <p className="mt-0.5 text-[11px] text-zinc-500">{n.message}</p>
                          <p className="mt-1 text-[10px] text-zinc-600">{formatTime(n.time)}</p>
                        </div>
                        <button onClick={() => dismissNotification(n.id)} className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-300">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Status dot */}
        <div className="hidden items-center gap-2 rounded-lg border border-zinc-800 px-3 py-1.5 sm:flex">
          <div className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-zinc-400">Connected</span>
        </div>

        {/* User menu */}
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/10 text-xs font-semibold text-sky-400 transition-colors hover:bg-sky-500/20"
          >
            {initials}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl">
              <div className="border-b border-zinc-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/10 text-xs font-semibold text-sky-400">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-zinc-200">
                      {user?.displayName ?? user?.email ?? "User"}
                    </p>
                    {user?.displayName && user?.email && (
                      <p className="truncate text-[10px] text-zinc-500">
                        {user.email}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="py-1">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/settings");
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  <User className="h-3.5 w-3.5" />
                  Profile
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/settings");
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </button>
              </div>
              <div className="border-t border-zinc-800 pt-1">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
