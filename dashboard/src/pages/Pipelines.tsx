import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowRight,
  Bot,
  Play,
  Plus,
  RemoveFormatting,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDuration } from "@/lib/utils";
import { mockAgents } from "@/hooks/use-mock-data";
import type { PipelineRunResult, PipelineStage } from "@/types/api";

interface PipelinePayload {
  agents: typeof mockAgents;
  offline: boolean;
}

function buildMockRun(input: string, stages: PipelineStage[]): PipelineRunResult {
  const stageResults: PipelineRunResult["stages"] = [];

  let currentInput = input;
  stages.forEach((stage, index) => {
    const output = `${stage.agentId} stage ${index + 1} refined: ${currentInput.slice(0, 80)}${currentInput.length > 80 ? "..." : ""}`;
    stageResults.push({
      agentId: stage.agentId,
      input: currentInput,
      output,
      durationMs: 800 + index * 175,
    });
    currentInput = output;
  });

  return {
    pipelineId: `mock-${Date.now()}`,
    stages: stageResults,
    finalOutput: stageResults[stageResults.length - 1]?.output ?? input,
    totalDurationMs: stageResults.reduce((sum, stage) => sum + stage.durationMs, 0),
  };
}

export function PipelinesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["pipeline-agents"],
    queryFn: async (): Promise<PipelinePayload> => {
      try {
        const agents = await api.agents.list();
        return { agents, offline: false };
      } catch {
        return { agents: mockAgents, offline: true };
      }
    },
    refetchInterval: 30_000,
  });

  const payload = data ?? { agents: mockAgents, offline: true };

  const [input, setInput] = useState(
    "Summarize this incident, identify the root cause, and draft a concise follow-up plan.",
  );
  const [stages, setStages] = useState<PipelineStage[]>([
    { agentId: payload.agents[1]?.id ?? "researcher", systemPromptSuffix: "Focus on evidence and root cause." },
    { agentId: payload.agents[2]?.id ?? "coder", systemPromptSuffix: "Convert the analysis into concrete actions." },
    { agentId: payload.agents[0]?.id ?? "writer", systemPromptSuffix: "Return a polished summary." },
  ]);
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  const [runOffline, setRunOffline] = useState(false);

  const runMutation = useMutation({
    mutationFn: async () => {
      try {
        const response = await api.pipelines.run(input, stages);
        return { result: response.pipeline, offline: false };
      } catch {
        return { result: buildMockRun(input, stages), offline: true };
      }
    },
    onSuccess: ({ result: pipelineResult, offline }) => {
      setResult(pipelineResult);
      setRunOffline(offline);
      toast.success(offline ? "Pipeline simulated locally" : "Pipeline finished");
    },
  });

  const updateStage = (index: number, patch: Partial<PipelineStage>) => {
    setStages((current) =>
      current.map((stage, stageIndex) =>
        stageIndex === index ? { ...stage, ...patch } : stage,
      ),
    );
  };

  const addStage = () => {
    setStages((current) => [
      ...current,
      { agentId: payload.agents[0]?.id ?? "researcher", systemPromptSuffix: "" },
    ]);
  };

  const removeStage = (index: number) => {
    setStages((current) => current.filter((_, stageIndex) => stageIndex !== index));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Tool Pipelines</h1>
          <p className="text-sm text-zinc-500">
            Chain multiple agents together and inspect each stage output
          </p>
        </div>
        <div className="flex items-center gap-3">
          {(payload.offline || runOffline) && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
              Fallback data
            </span>
          )}
          <button
            onClick={() => runMutation.mutate()}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
          >
            <Play className="h-3.5 w-3.5" />
            Run Pipeline
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Agents Available" value={payload.agents.length} icon={Bot} change="Candidates for stages" />
          <StatCard title="Stages" value={stages.length} icon={Sparkles} change="Pipeline depth" />
          <StatCard title="Input Size" value={`${input.length} chars`} icon={RemoveFormatting} change="Prompt text" />
          <StatCard title="Last Duration" value={result ? formatDuration(result.totalDurationMs) : "—"} icon={ArrowRight} change="Most recent run" />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-zinc-300">Pipeline Builder</h2>
                <p className="text-xs text-zinc-500">
                  Each stage feeds the next. Changes are safe to test locally.
                </p>
              </div>
              <StatusBadge status={runMutation.isPending ? "busy" : "healthy"} />
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-400">
                  Input
                </label>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="space-y-3">
                {stages.map((stage, index) => (
                  <div
                    key={`${stage.agentId}-${index}`}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-xs font-semibold text-zinc-300">
                        Stage {index + 1}
                      </p>
                      <button
                        onClick={() => removeStage(index)}
                        className="rounded-md px-2 py-1 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                          Agent
                        </label>
                        <select
                          value={stage.agentId}
                          onChange={(e) =>
                            updateStage(index, { agentId: e.target.value })
                          }
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 focus:border-sky-500 focus:outline-none"
                        >
                          {payload.agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.displayName}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                          Prompt suffix
                        </label>
                        <input
                          value={stage.systemPromptSuffix ?? ""}
                          onChange={(e) =>
                            updateStage(index, {
                              systemPromptSuffix: e.target.value,
                            })
                          }
                          placeholder="Optional instruction for this stage"
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={addStage}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Stage
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-300">
              Execution Result
            </h2>
            {result ? (
              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Pipeline ID</span>
                  <span className="font-mono text-zinc-300">{result.pipelineId}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Stages</span>
                  <span className="text-zinc-300">{result.stages.length}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Duration</span>
                  <span className="text-zinc-300">{formatDuration(result.totalDurationMs)}</span>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Stage Outputs</p>
                  <div className="space-y-2">
                    {result.stages.map((stage, index) => (
                      <div key={`${stage.agentId}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                        <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
                          <span>{stage.agentId}</span>
                          <span>{formatDuration(stage.durationMs)}</span>
                        </div>
                        <p className="text-[11px] text-zinc-300">{stage.output}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-zinc-500">Final Output</p>
                  <pre className="max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-300">
                    {result.finalOutput}
                  </pre>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={Play}
                title="No run yet"
                description="Execute the pipeline to inspect stage outputs and timing."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
