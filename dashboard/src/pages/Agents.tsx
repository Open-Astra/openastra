import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Layers,
  Search,
  Cpu,
  Wrench,
  Brain,
  GitBranch,
  ChevronRight,
  Zap,
  Pencil,
  X,
  Plus,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn, formatNumber, formatRelativeTime } from "@/lib/utils";
import { mockAgents, mockSwarms } from "@/hooks/use-mock-data";
import type { Agent } from "@/types/api";

interface AgentConfigEditorProps {
  agent: Agent;
  onClose: () => void;
}

function AgentConfigEditor({ agent, onClose }: AgentConfigEditorProps) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [provider, setProvider] = useState(agent.model.provider);
  const [modelId, setModelId] = useState(agent.model.modelId);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPromptTemplate ?? "");
  const [skills, setSkills] = useState<string[]>([...agent.skills]);
  const [allowedTools, setAllowedTools] = useState<string[]>([...(agent.tools.allow ?? [])]);
  const [maxCalls, setMaxCalls] = useState(agent.tools.maxCalls ?? 50);
  const [newSkill, setNewSkill] = useState("");
  const [newTool, setNewTool] = useState("");
  const [spawnEnabled, setSpawnEnabled] = useState(agent.spawn?.enabled ?? false);
  const [maxDepth, setMaxDepth] = useState(agent.spawn?.maxDepth ?? 3);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Agent>) => api.agents.update(agent.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`${displayName} updated`);
      onClose();
    },
    onError: () => {
      toast.success(`${displayName} updated (mock)`);
      onClose();
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      displayName,
      model: { provider, modelId },
      systemPromptTemplate: systemPrompt || undefined,
      skills,
      tools: {
        allow: allowedTools.length > 0 ? allowedTools : undefined,
        maxCalls,
      },
      spawn: { enabled: spawnEnabled, maxDepth },
    });
  };

  const addSkill = () => {
    if (newSkill.trim() && !skills.includes(newSkill.trim())) {
      setSkills([...skills, newSkill.trim()]);
      setNewSkill("");
    }
  };

  const addTool = () => {
    if (newTool.trim() && !allowedTools.includes(newTool.trim())) {
      setAllowedTools([...allowedTools, newTool.trim()]);
      setNewTool("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-sky-500/10 p-2">
              <Pencil className="h-4 w-4 text-sky-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Edit Agent</h2>
              <p className="text-[10px] font-mono text-zinc-500">{agent.id}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Basic Info */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Basic Info</h3>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Display Name</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:border-sky-500 focus:outline-none"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="groq">Groq</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Model ID</label>
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-sky-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">System Prompt</h3>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              placeholder="Enter the system prompt template for this agent..."
              className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-700 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {/* Skills */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Skills</h3>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((skill) => (
                <span key={skill} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300">
                  {skill}
                  <button onClick={() => setSkills(skills.filter((s) => s !== skill))} className="ml-0.5 text-zinc-600 hover:text-red-400">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSkill())}
                placeholder="Add skill..."
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none"
              />
              <button onClick={addSkill} className="rounded-lg border border-zinc-800 px-2 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Tools */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Allowed Tools</h3>
            <div className="flex flex-wrap gap-1.5">
              {allowedTools.map((tool) => (
                <span key={tool} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-300">
                  {tool}
                  <button onClick={() => setAllowedTools(allowedTools.filter((t) => t !== tool))} className="ml-0.5 text-zinc-600 hover:text-red-400">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {allowedTools.length === 0 && <span className="text-[10px] text-zinc-600">All tools allowed (no restrictions)</span>}
            </div>
            <div className="flex gap-2">
              <input
                value={newTool}
                onChange={(e) => setNewTool(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTool())}
                placeholder="Add tool..."
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-200 focus:border-sky-500 focus:outline-none"
              />
              <button onClick={addTool} className="rounded-lg border border-zinc-800 px-2 py-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Max Tool Calls per Session</label>
              <input
                type="number"
                value={maxCalls}
                onChange={(e) => setMaxCalls(parseInt(e.target.value) || 0)}
                className="w-32 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Spawning */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Spawning</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-zinc-300">Enable sub-agent spawning</p>
                <p className="text-[10px] text-zinc-600">Allow this agent to spawn child agents</p>
              </div>
              <button
                onClick={() => setSpawnEnabled(!spawnEnabled)}
                className={cn("relative h-5 w-9 rounded-full transition-colors", spawnEnabled ? "bg-sky-600" : "bg-zinc-700")}
              >
                <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform", spawnEnabled ? "left-[18px]" : "left-0.5")} />
              </button>
            </div>
            {spawnEnabled && (
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Max Spawn Depth</label>
                <input
                  type="number"
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(parseInt(e.target.value) || 1)}
                  min={1}
                  max={10}
                  className="w-32 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200 focus:border-sky-500 focus:outline-none"
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500"
          >
            <Save className="h-3.5 w-3.5" />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentsPage() {
  const [view, setView] = useState<"agents" | "swarms">("agents");
  const [search, setSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list().catch(() => mockAgents),
  });

  const { data: swarms } = useQuery({
    queryKey: ["swarms"],
    queryFn: () => api.swarms.list().catch(() => mockSwarms),
  });

  const agentList = agents ?? mockAgents;
  const swarmList = swarms ?? mockSwarms;

  const filteredAgents = agentList.filter(
    (a) =>
      a.displayName.toLowerCase().includes(search.toLowerCase()) ||
      a.id.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredSwarms = swarmList.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.id.toLowerCase().includes(search.toLowerCase()),
  );

  const detail = selectedAgent
    ? agentList.find((a) => a.id === selectedAgent)
    : null;

  return (
    <div className="space-y-6">
      {/* Config Editor Modal */}
      {editingAgent && (
        <AgentConfigEditor agent={editingAgent} onClose={() => setEditingAgent(null)} />
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Agents & Swarms</h1>
          <p className="text-sm text-zinc-500">
            {agentList.length} agents, {swarmList.length} swarms
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div className="flex rounded-lg border border-zinc-800">
            <button
              onClick={() => setView("agents")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                view === "agents"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Bot className="h-3.5 w-3.5" />
              Agents
            </button>
            <button
              onClick={() => setView("swarms")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                view === "swarms"
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              Swarms
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* List */}
        <div className="space-y-3 lg:col-span-2">
          {view === "agents" ? (
            filteredAgents.length > 0 ? (
              filteredAgents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                  className={cn(
                    "w-full rounded-xl border bg-zinc-900/50 p-4 text-left transition-all hover:border-zinc-700",
                    selectedAgent === agent.id
                      ? "border-sky-500/50"
                      : "border-zinc-800",
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
                        <Bot className="h-5 w-5 text-zinc-400" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-200">
                          {agent.displayName}
                        </h3>
                        <p className="text-[10px] font-mono text-zinc-600">
                          {agent.id}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={agent.status} />
                      <ChevronRight className="h-4 w-4 text-zinc-600" />
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-500">
                    <span className="flex items-center gap-1">
                      <Cpu className="h-3 w-3" />
                      {agent.model.provider}/{agent.model.modelId}
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {formatNumber(agent.totalInferences)} inferences
                    </span>
                    <span className="flex items-center gap-1">
                      <Wrench className="h-3 w-3" />
                      {agent.skills.length} skills
                    </span>
                    {agent.lastActiveAt && (
                      <span>Active {formatRelativeTime(agent.lastActiveAt)}</span>
                    )}
                  </div>
                </button>
              ))
            ) : (
              <EmptyState
                icon={Bot}
                title="No agents found"
                description="No agents match your search. Try a different query."
              />
            )
          ) : filteredSwarms.length > 0 ? (
            filteredSwarms.map((swarm) => (
              <div
                key={swarm.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
                      <Layers className="h-5 w-5 text-violet-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-200">
                        {swarm.name}
                      </h3>
                      <p className="text-[10px] text-zinc-500">
                        {swarm.topology} topology · {swarm.agents.length} agents
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={swarm.status} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {swarm.agents.map((agentId) => {
                    const agent = agentList.find((a) => a.id === agentId);
                    return (
                      <span
                        key={agentId}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400"
                      >
                        {agent?.displayName ?? agentId}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <EmptyState
              icon={Layers}
              title="No swarms found"
              description="No swarms match your search."
            />
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-1">
          {detail ? (
            <div className="sticky top-6 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800">
                    <Bot className="h-6 w-6 text-sky-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{detail.displayName}</h3>
                    <p className="text-xs text-zinc-500">{detail.tier} tier</p>
                  </div>
                </div>
                <button
                  onClick={() => setEditingAgent(detail)}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Model</span>
                  <span className="font-mono text-zinc-300">
                    {detail.model.provider}/{detail.model.modelId}
                  </span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Status</span>
                  <StatusBadge status={detail.status} />
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Sessions</span>
                  <span className="text-zinc-300">{detail.sessionCount}</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                  <span className="text-zinc-500">Inferences</span>
                  <span className="text-zinc-300">
                    {formatNumber(detail.totalInferences)}
                  </span>
                </div>
                {detail.spawn?.enabled && (
                  <div className="flex justify-between border-b border-zinc-800 pb-2">
                    <span className="text-zinc-500">Spawning</span>
                    <span className="flex items-center gap-1 text-zinc-300">
                      <GitBranch className="h-3 w-3" />
                      Max depth {detail.spawn.maxDepth}
                    </span>
                  </div>
                )}
                {detail.memoryNamespace && (
                  <div className="flex justify-between border-b border-zinc-800 pb-2">
                    <span className="text-zinc-500">Memory</span>
                    <span className="flex items-center gap-1 text-zinc-300">
                      <Brain className="h-3 w-3" />
                      {detail.memoryNamespace}
                    </span>
                  </div>
                )}
              </div>

              {/* System Prompt Preview */}
              {detail.systemPromptTemplate && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-zinc-400">System Prompt</h4>
                  <pre className="max-h-24 overflow-y-auto rounded-lg bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-500">
                    {detail.systemPromptTemplate}
                  </pre>
                </div>
              )}

              {/* Skills */}
              <div>
                <h4 className="mb-2 text-xs font-medium text-zinc-400">
                  Skills
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-md bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </div>

              {/* Tools */}
              {detail.tools.allow && (
                <div>
                  <h4 className="mb-2 text-xs font-medium text-zinc-400">
                    Allowed Tools
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tools.allow.map((tool) => (
                      <span
                        key={tool}
                        className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-center">
              <p className="text-xs text-zinc-600">
                Select an agent to view details
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
