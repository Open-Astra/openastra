import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execFileSync } from "node:child_process";

// ── Docker Management Skill ─────────────────────────────────────────
// List, inspect, start/stop containers, and view logs via Docker CLI.

const MAX_OUTPUT = 5000;

/** Validate container name/ID to prevent injection via crafted identifiers. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateContainerName(name: string): string | null {
  if (!CONTAINER_NAME_RE.test(name)) {
    return `Invalid container name or ID: "${name}". Must match ${CONTAINER_NAME_RE.source}`;
  }
  return null;
}

const ListContainersParams = z.object({
  all: z.boolean().default(false).describe("Include stopped containers"),
});

const ContainerLogsParams = z.object({
  container: z.string().describe("Container name or ID"),
  tail: z.number().int().min(1).max(500).default(50).describe("Number of lines from end"),
});

const ContainerActionParams = z.object({
  container: z.string().describe("Container name or ID"),
  action: z.enum(["start", "stop", "restart", "inspect"]).describe("Action to perform"),
});

const ListImagesParams = z.object({});

function dockerExec(args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf-8", timeout: 15_000 }).trim().slice(0, MAX_OUTPUT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `ERROR: ${msg.slice(0, 500)}`;
  }
}

const dockerManageSkill: SkillDefinition = {
  name: "docker_manage",
  version: "1.0.0",

  manifest: {
    id: "docker_manage",
    name: "Docker Management",
    description: "List containers, view logs, start/stop/restart containers, and inspect images.",
    category: "execute",
    tools: ["docker_containers", "docker_logs", "docker_action", "docker_images"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "docker_containers",
      description: "List Docker containers with status, ports, and resource usage.",
      parameters: ListContainersParams,

      async execute(params) {
        const args = ["ps", "--format", "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"];
        if (params.all) args.splice(1, 0, "-a");
        const output = dockerExec(args);
        if (output.startsWith("ERROR")) return { error: output };

        const containers = output.split("\n").filter((l) => l.includes("|")).map((l) => {
          const [id, name, image, status, ports] = l.split("|");
          return { id, name, image, status, ports };
        });

        return { count: containers.length, containers };
      },
    });

    ctx.registerTool({
      name: "docker_logs",
      description: "View recent logs from a Docker container.",
      parameters: ContainerLogsParams,

      async execute(params) {
        const nameErr = validateContainerName(params.container);
        if (nameErr) return { error: nameErr };

        const output = dockerExec(["logs", "--tail", String(params.tail), params.container]);
        if (output.startsWith("ERROR")) return { error: output };
        return { container: params.container, lines: params.tail, logs: output };
      },
    });

    ctx.registerTool({
      name: "docker_action",
      description: "Start, stop, restart, or inspect a Docker container.",
      parameters: ContainerActionParams,

      async execute(params) {
        const nameErr = validateContainerName(params.container);
        if (nameErr) return { error: nameErr };

        if (params.action === "inspect") {
          const output = dockerExec(["inspect", "--format", "{{json .}}", params.container]);
          if (output.startsWith("ERROR")) return { error: output };
          try {
            const info = JSON.parse(output) as Record<string, unknown>;
            return {
              name: info.Name,
              state: info.State,
              image: (info.Config as Record<string, unknown>)?.Image,
              created: info.Created,
              networkSettings: info.NetworkSettings,
            };
          } catch {
            return { raw: output.slice(0, 2000) };
          }
        }

        const output = dockerExec([params.action, params.container]);
        if (output.startsWith("ERROR")) return { error: output };
        return { success: true, action: params.action, container: params.container };
      },
    });

    ctx.registerTool({
      name: "docker_images",
      description: "List Docker images on the system.",
      parameters: ListImagesParams,

      async execute() {
        const output = dockerExec(["images", "--format", "{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}"]);
        if (output.startsWith("ERROR")) return { error: output };

        const images = output.split("\n").filter((l) => l.includes("|")).map((l) => {
          const [repository, tag, id, size, created] = l.split("|");
          return { repository, tag, id, size, created };
        });

        return { count: images.length, images };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "docker_manage",
      instructions: "You can manage Docker with `docker_containers` (list), `docker_logs` (view logs), `docker_action` (start/stop/restart/inspect), and `docker_images` (list images).",
    };
  },
};

export default dockerManageSkill;
