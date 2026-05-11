import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// ── Process Manager Skill ───────────────────────────────────────────
// List, monitor, and manage system processes.

const ListProcessesParams = z.object({
  filter: z.string().optional().describe("Filter processes by name"),
  limit: z.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["cpu", "memory", "pid"]).default("cpu"),
});

const ProcessInfoParams = z.object({
  pid: z.number().int().describe("Process ID to inspect"),
});

const FindProcessParams = z.object({
  port: z.number().int().optional().describe("Find process listening on this port"),
  name: z.string().optional().describe("Find process by name"),
});

function execFile(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    return "";
  }
}

const processManagerSkill: SkillDefinition = {
  name: "process_manager",
  version: "1.0.0",

  manifest: {
    id: "process_manager",
    name: "Process Manager",
    description: "List, monitor, and find system processes. Find processes by port or name.",
    category: "analyze",
    tools: ["process_list", "process_info", "process_find"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "process_list",
      description: "List running processes sorted by CPU or memory usage.",
      parameters: ListProcessesParams,

      async execute(params) {
        const sortFlag = params.sortBy === "memory" ? "-%mem" : params.sortBy === "pid" ? "pid" : "-%cpu";
        const psOutput = execFile("ps", ["aux", `--sort=${sortFlag}`]);
        if (!psOutput) return { count: 0, sortBy: params.sortBy, processes: [] };

        let lines = psOutput.split("\n").filter((l) => l.trim());

        // If filter is provided, filter lines (case-insensitive) — skip the header
        const hasHeader = lines[0]?.includes("USER") || lines[0]?.includes("PID");
        if (params.filter) {
          const filterLower = params.filter.toLowerCase();
          lines = lines.filter((l, i) => {
            if (i === 0 && hasHeader) return false;
            return l.toLowerCase().includes(filterLower);
          });
        }

        const dataLines = hasHeader && !params.filter ? lines.slice(1, params.limit + 1) : lines.slice(0, params.limit);

        const processes = dataLines.map((line) => {
          const parts = line.split(/\s+/);
          return {
            user: parts[0],
            pid: parseInt(parts[1] ?? "0", 10),
            cpu: `${parts[2]}%`,
            memory: `${parts[3]}%`,
            vsz: parts[4],
            rss: parts[5],
            stat: parts[7],
            started: parts[8],
            command: parts.slice(10).join(" ").slice(0, 80),
          };
        });

        return { count: processes.length, sortBy: params.sortBy, processes };
      },
    });

    ctx.registerTool({
      name: "process_info",
      description: "Get detailed info about a specific process by PID.",
      parameters: ProcessInfoParams,

      async execute(params) {
        const pidStr = String(params.pid);
        const info = execFile("ps", ["-p", pidStr, "-o", "pid,user,%cpu,%mem,vsz,rss,stat,start,time,command"]);
        if (!info || info.split("\n").length < 2) return { error: `Process ${params.pid} not found.` };

        const line = info.split("\n")[1]!;
        const parts = line.trim().split(/\s+/);

        // Additional info via /proc filesystem (direct read, no shell)
        let cmdline: string | null = null;
        let openFiles: number | null = null;
        let threads: number | null = null;
        try {
          cmdline = readFileSync(`/proc/${pidStr}/cmdline`, "utf-8").replace(/\0/g, " ").trim() || null;
        } catch { /* not available */ }
        try {
          openFiles = readdirSync(`/proc/${pidStr}/fd`).length;
        } catch { /* not available */ }
        try {
          threads = readdirSync(`/proc/${pidStr}/task`).length;
        } catch { /* not available */ }

        return {
          pid: params.pid,
          user: parts[1],
          cpu: `${parts[2]}%`,
          memory: `${parts[3]}%`,
          vsz: parts[4],
          rss: parts[5],
          stat: parts[6],
          started: parts[7],
          cpuTime: parts[8],
          command: parts.slice(9).join(" "),
          fullCommand: cmdline,
          openFiles,
          threads,
        };
      },
    });

    ctx.registerTool({
      name: "process_find",
      description: "Find a process by port number or name.",
      parameters: FindProcessParams,

      async execute(params) {
        if (params.port) {
          let output = execFile("lsof", ["-i", `:${params.port}`, "-P", "-n"]);
          if (!output) {
            // Fallback to ss
            output = execFile("ss", ["-tlnp", `sport = :${params.port}`]);
          }
          if (!output) return { error: `No process found on port ${params.port}` };

          return { port: params.port, output: output.slice(0, 2000) };
        }

        if (params.name) {
          const output = execFile("pgrep", ["-a", params.name]);
          if (!output) return { error: `No process found matching "${params.name}"` };

          const processes = output.split("\n").filter((l) => l.trim()).map((l) => {
            const [pid, ...cmd] = l.split(/\s+/);
            return { pid: parseInt(pid!, 10), command: cmd.join(" ") };
          });

          return { name: params.name, count: processes.length, processes };
        }

        return { error: "Provide either port or name to search for." };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "process_manager",
      instructions: "You can manage processes with `process_list` (list by CPU/memory), `process_info` (detailed PID info), and `process_find` (find by port or name).",
    };
  },
};

export default processManagerSkill;
