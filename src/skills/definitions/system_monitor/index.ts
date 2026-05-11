import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execFileSync } from "node:child_process";
import * as os from "node:os";

// ── System Monitor Skill ────────────────────────────────────────────
// Monitor CPU, RAM, disk, and network stats. Uses Node.js os module
// and shell commands for detailed metrics.

const SystemInfoParams = z.object({});

const DiskUsageParams = z.object({
  path: z.string().default("/").describe("Path to check disk usage for"),
});

const TopProcessesParams = z.object({
  count: z.number().int().min(1).max(20).default(10).describe("Number of top processes"),
  sortBy: z.enum(["cpu", "memory"]).default("cpu"),
});

const systemMonitorSkill: SkillDefinition = {
  name: "system_monitor",
  version: "1.0.0",

  manifest: {
    id: "system_monitor",
    name: "System Monitor",
    description: "Monitor system resources: CPU, RAM, disk, network, and top processes.",
    category: "analyze",
    tools: ["system_info", "system_disk", "system_top"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "system_info",
      description: "Get system information: CPU, memory, uptime, OS, and load averages.",
      parameters: SystemInfoParams,

      async execute() {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        return {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          osRelease: os.release(),
          nodeVersion: process.version,
          cpu: {
            model: cpus[0]?.model ?? "unknown",
            cores: cpus.length,
            speed: `${cpus[0]?.speed ?? 0} MHz`,
          },
          memory: {
            total: `${Math.round(totalMem / 1024 / 1024)} MB`,
            used: `${Math.round(usedMem / 1024 / 1024)} MB`,
            free: `${Math.round(freeMem / 1024 / 1024)} MB`,
            usagePercent: Math.round((usedMem / totalMem) * 100),
          },
          uptime: {
            system: `${Math.round(os.uptime() / 3600)} hours`,
            process: `${Math.round(process.uptime() / 3600)} hours`,
          },
          loadAverage: os.loadavg().map((l) => Math.round(l * 100) / 100),
          networkInterfaces: Object.entries(os.networkInterfaces())
            .filter(([, addrs]) => addrs?.some((a) => !a.internal))
            .map(([name, addrs]) => ({
              name,
              addresses: addrs?.filter((a) => !a.internal).map((a) => ({ address: a.address, family: a.family })),
            })),
        };
      },
    });

    ctx.registerTool({
      name: "system_disk",
      description: "Check disk usage for a given path.",
      parameters: DiskUsageParams,

      async execute(params) {
        try {
          let output: string;
          try {
            output = execFileSync("df", ["-h", params.path], { encoding: "utf-8", timeout: 5_000 });
          } catch {
            // Fallback: df without -h flag
            output = execFileSync("df", [params.path], { encoding: "utf-8", timeout: 5_000 });
          }
          const lines = output.trim().split("\n");
          if (lines.length < 2) return { error: "Could not parse disk usage." };

          const parts = lines[1]!.split(/\s+/);
          return {
            path: params.path,
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usagePercent: parts[4],
            mountedOn: parts[5],
          };
        } catch (err) {
          return { error: `Failed to get disk usage: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    ctx.registerTool({
      name: "system_top",
      description: "List top processes by CPU or memory usage.",
      parameters: TopProcessesParams,

      async execute(params) {
        try {
          const sortFlag = params.sortBy === "memory" ? "--sort=-%mem" : "--sort=-%cpu";
          const output = execFileSync(
            "ps",
            ["aux", sortFlag],
            { encoding: "utf-8", timeout: 5_000 },
          );

          const lines = output.trim().split("\n");
          // Take only the requested count (skip header line, limit data lines)
          const processes = lines.slice(1, params.count + 1).map((line) => {
            const parts = line.split(/\s+/);
            return {
              user: parts[0],
              pid: parts[1],
              cpu: `${parts[2]}%`,
              memory: `${parts[3]}%`,
              command: parts.slice(10).join(" ").slice(0, 60),
            };
          });

          return { sortBy: params.sortBy, count: processes.length, processes };
        } catch (err) {
          return { error: `Failed to list processes: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "system_monitor",
      instructions: "You can monitor system resources with `system_info` (CPU/RAM/uptime), `system_disk` (disk usage), and `system_top` (top processes by CPU or memory).",
    };
  },
};

export default systemMonitorSkill;
