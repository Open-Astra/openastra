import { useQuery } from "@tanstack/react-query";
import {
  Server,
  Wifi,
  WifiOff,
  Clock,
  Gauge,
  DollarSign,
  Hash,
  Activity,
} from "lucide-react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { cn, formatNumber, formatRelativeTime } from "@/lib/utils";
import { mockProviders, mockChannels } from "@/hooks/use-mock-data";

export function SystemPage() {
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.providers.list().catch(() => mockProviders),
    refetchInterval: 30_000,
  });

  const { data: channels } = useQuery({
    queryKey: ["channels"],
    queryFn: () => api.channels.list().catch(() => mockChannels),
    refetchInterval: 30_000,
  });

  const providerList = providers ?? mockProviders;
  const channelList = channels ?? mockChannels;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">System & Monitoring</h1>
        <p className="text-sm text-zinc-500">
          Inference providers, channels, and system health
        </p>
      </div>

      {/* Inference Providers */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Inference Providers
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providerList.map((provider) => (
            <div
              key={provider.id}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-lg",
                      provider.connected
                        ? "bg-emerald-500/10"
                        : "bg-zinc-800",
                    )}
                  >
                    <Server
                      className={cn(
                        "h-5 w-5",
                        provider.connected
                          ? "text-emerald-400"
                          : "text-zinc-600",
                      )}
                    />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-200">
                      {provider.name}
                    </h3>
                    <p className="text-[10px] text-zinc-500">
                      {provider.models.length} model
                      {provider.models.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
                <StatusBadge status={provider.status} />
              </div>

              {/* Models */}
              <div className="mt-3 flex flex-wrap gap-1">
                {provider.models.map((model) => (
                  <span
                    key={model}
                    className="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500"
                  >
                    {model}
                  </span>
                ))}
              </div>

              {/* Stats */}
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3">
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 text-[10px] text-zinc-500">
                    <Hash className="h-2.5 w-2.5" />
                    Requests
                  </div>
                  <p className="text-xs font-bold text-zinc-300">
                    {formatNumber(provider.requestsToday)}
                  </p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1 text-[10px] text-zinc-500">
                    <Activity className="h-2.5 w-2.5" />
                    Tokens
                  </div>
                  <p className="text-xs font-bold text-zinc-300">
                    {formatNumber(provider.tokensToday)}
                  </p>
                </div>
                {provider.latency != null && (
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-[10px] text-zinc-500">
                      <Gauge className="h-2.5 w-2.5" />
                      Latency
                    </div>
                    <p className="text-xs font-bold text-zinc-300">
                      {provider.latency}ms
                    </p>
                  </div>
                )}
                {provider.costToday != null && !provider.latency && (
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-[10px] text-zinc-500">
                      <DollarSign className="h-2.5 w-2.5" />
                      Cost
                    </div>
                    <p className="text-xs font-bold text-zinc-300">
                      ${provider.costToday.toFixed(2)}
                    </p>
                  </div>
                )}
              </div>

              {provider.costToday != null && provider.latency != null && (
                <div className="mt-2 text-center text-[10px] text-zinc-500">
                  <DollarSign className="inline h-2.5 w-2.5" />{" "}
                  ${provider.costToday.toFixed(2)} today
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Channel Integrations */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Channel Integrations
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {channelList.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700"
            >
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg",
                  channel.connected ? "bg-sky-500/10" : "bg-zinc-800",
                )}
              >
                {channel.connected ? (
                  <Wifi className="h-5 w-5 text-sky-400" />
                ) : (
                  <WifiOff className="h-5 w-5 text-zinc-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-zinc-200">
                  {channel.name}
                </h3>
                <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                  <span className="capitalize">{channel.type}</span>
                  {channel.lastActivity && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {formatRelativeTime(channel.lastActivity)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div
                className={cn(
                  "h-2 w-2 rounded-full",
                  channel.connected ? "bg-emerald-400" : "bg-zinc-600",
                )}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Quick info */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Runtime Info
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Platform</span>
              <span className="text-zinc-300">Node.js 20+</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Framework</span>
              <span className="text-zinc-300">Express 5.2</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Database</span>
              <span className="text-zinc-300">PostgreSQL 17 + pgvector</span>
            </div>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Search Engine</span>
              <span className="text-zinc-300">Typesense 27.1</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Real-time</span>
              <span className="text-zinc-300">WebSocket (ws)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Auth</span>
              <span className="text-zinc-300">JWT + bcrypt</span>
            </div>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">API Routes</span>
              <span className="text-zinc-300">165 endpoints</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Built-in Tools</span>
              <span className="text-zinc-300">67+</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Skills</span>
              <span className="text-zinc-300">106</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
