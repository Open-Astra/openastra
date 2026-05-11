import { useState, useRef } from "react";
import {
  Settings as SettingsIcon,
  Key,
  Palette,
  Bell,
  Shield,
  RefreshCw,
  Save,
  Eye,
  EyeOff,
  ExternalLink,
  Download,
  Upload,
  FileJson,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { mockAgents, mockScheduledTasks } from "@/hooks/use-mock-data";

interface SettingsSectionProps {
  title: string;
  description: string;
  icon: typeof SettingsIcon;
  children: React.ReactNode;
}

function SettingsSection({ title, description, icon: Icon, children }: SettingsSectionProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-zinc-800/50 p-2">
          <Icon className="h-4 w-4 text-zinc-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function ApiKeyField({ label, envVar }: { label: string; envVar: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex items-center justify-between border-b border-zinc-800/50 py-2.5 last:border-0">
      <div>
        <p className="text-xs font-medium text-zinc-300">{label}</p>
        <p className="font-mono text-[10px] text-zinc-600">{envVar}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-zinc-500">
          {visible ? "sk-•••••••••••••1234" : "••••••••••••••••"}
        </span>
        <button
          onClick={() => setVisible(!visible)}
          className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400"
        >
          {visible ? (
            <EyeOff className="h-3 w-3" />
          ) : (
            <Eye className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}

interface ExportData {
  version: string;
  exportedAt: string;
  settings: {
    theme: string;
    logLevel: string;
    notifications: boolean;
    fastMode: boolean;
  };
  agents: typeof mockAgents;
  scheduledTasks: typeof mockScheduledTasks;
}

export function SettingsPage() {
  const [theme, setTheme] = useState("dark");
  const [logLevel, setLogLevel] = useState("info");
  const [notifications, setNotifications] = useState(true);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fastMode = useAppStore((s) => s.fastMode);

  const handleSave = () => {
    toast.success("Settings saved successfully");
  };

  const handleExport = () => {
    const exportData: ExportData = {
      version: "2.0.0",
      exportedAt: new Date().toISOString(),
      settings: {
        theme,
        logLevel,
        notifications,
        fastMode,
      },
      agents: mockAgents,
      scheduledTasks: mockScheduledTasks,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openastra-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Configuration exported");
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string) as ExportData;

        if (!data.version || !data.settings) {
          setImportResult({ success: false, message: "Invalid config file format" });
          return;
        }

        // Apply settings
        if (data.settings.theme) setTheme(data.settings.theme);
        if (data.settings.logLevel) setLogLevel(data.settings.logLevel);
        if (data.settings.notifications !== undefined) setNotifications(data.settings.notifications);

        const agentCount = data.agents?.length ?? 0;
        const taskCount = data.scheduledTasks?.length ?? 0;

        setImportResult({
          success: true,
          message: `Imported: ${agentCount} agents, ${taskCount} tasks, settings applied`,
        });
        toast.success("Configuration imported successfully");
      } catch {
        setImportResult({ success: false, message: "Failed to parse JSON file" });
        toast.error("Invalid JSON file");
      }
    };
    reader.readAsText(file);

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-zinc-500">
            Configure your OpenAstra dashboard
          </p>
        </div>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
        >
          <Save className="h-3.5 w-3.5" />
          Save Changes
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* API Keys */}
        <SettingsSection
          title="API Keys"
          description="Manage inference provider credentials"
          icon={Key}
        >
          <div className="space-y-0">
            <ApiKeyField label="Anthropic" envVar="ANTHROPIC_API_KEY" />
            <ApiKeyField label="OpenAI" envVar="OPENAI_API_KEY" />
            <ApiKeyField label="Google AI" envVar="GEMINI_API_KEY" />
            <ApiKeyField label="Groq" envVar="GROQ_API_KEY" />
            <ApiKeyField label="OpenRouter" envVar="OPENROUTER_API_KEY" />
          </div>
          <p className="mt-3 text-[10px] text-zinc-600">
            Keys are stored as environment variables and never exposed to the
            client. Manage them in your <code>.env</code> file.
          </p>
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection
          title="Appearance"
          description="Customize the dashboard look and feel"
          icon={Palette}
        >
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-400">
                Theme
              </label>
              <div className="flex gap-2">
                {["dark", "system"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={cn(
                      "rounded-lg border px-4 py-2 text-xs font-medium capitalize transition-colors",
                      theme === t
                        ? "border-sky-500/50 bg-sky-500/10 text-sky-400"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-700",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SettingsSection>

        {/* Notifications */}
        <SettingsSection
          title="Notifications"
          description="Configure alerts and event notifications"
          icon={Bell}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-zinc-300">
                  Live event feed
                </p>
                <p className="text-[10px] text-zinc-600">
                  Show real-time events in the dashboard
                </p>
              </div>
              <button
                onClick={() => setNotifications(!notifications)}
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors",
                  notifications ? "bg-sky-600" : "bg-zinc-700",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                    notifications ? "left-[18px]" : "left-0.5",
                  )}
                />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-zinc-300">
                  Error alerts
                </p>
                <p className="text-[10px] text-zinc-600">
                  Toast notifications for agent errors
                </p>
              </div>
              <button
                className="relative h-5 w-9 rounded-full bg-sky-600 transition-colors"
              >
                <span className="absolute left-[18px] top-0.5 h-4 w-4 rounded-full bg-white" />
              </button>
            </div>
          </div>
        </SettingsSection>

        {/* Export / Import */}
        <SettingsSection
          title="Export / Import"
          description="Backup and restore your configuration"
          icon={FileJson}
        >
          <div className="space-y-3">
            <p className="text-[10px] text-zinc-500">
              Export your agents, scheduled tasks, and settings as a JSON file. Import to restore or migrate between instances.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <Download className="h-3.5 w-3.5" />
                Export Config
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
              >
                <Upload className="h-3.5 w-3.5" />
                Import Config
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
            </div>
            {importResult && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-3",
                  importResult.success
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                    : "border-red-500/30 bg-red-500/5 text-red-400",
                )}
              >
                {importResult.success ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span className="text-xs">{importResult.message}</span>
              </div>
            )}
          </div>
        </SettingsSection>

        {/* Advanced */}
        <SettingsSection
          title="Advanced"
          description="System-level configuration"
          icon={Shield}
        >
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-400">
                Log Level
              </label>
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div>
                <p className="text-xs font-medium text-zinc-300">
                  Check for Updates
                </p>
                <p className="text-[10px] text-zinc-600">
                  Current version: 2.0.0
                </p>
              </div>
              <button className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200">
                <RefreshCw className="h-3 w-3" />
                Check
              </button>
            </div>
            <a
              href="https://openastra.net"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300"
            >
              <ExternalLink className="h-3 w-3" />
              OpenAstra Documentation
            </a>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
