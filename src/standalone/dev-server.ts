import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

// ── Unified Dev Server ─────────────────────────────────────────────
// `astra dev` — starts gateway, dashboard, and websocket bridge in
// parallel with colored, multiplexed output. Replaces running
// multiple terminals for development.
//
// Process tree:
//   astra dev
//   ├── Gateway     (tsx watch src/gateway/index.ts)
//   ├── Dashboard   (npm run dev --prefix dashboard)
//   └── (optional)  TypeScript type-checker (tsc --watch --noEmit)

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

interface ServiceConfig {
  name: string;
  color: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  optional?: boolean;
}

const COLORS = {
  gateway: "\x1b[36m",    // cyan
  dashboard: "\x1b[35m",  // magenta
  typecheck: "\x1b[33m",  // yellow
  system: "\x1b[32m",     // green
};

function prefix(name: string, color: string): string {
  return `${color}[${name}]${RESET}`;
}

function logLine(name: string, color: string, data: string): void {
  const lines = data.toString().split("\n").filter((l) => l.trim());
  for (const line of lines) {
    console.log(`${prefix(name, color)} ${line}`);
  }
}

export async function startDevServer(): Promise<void> {
  const rootDir = process.cwd();
  const dashboardDir = join(rootDir, "dashboard");

  console.log(`\n${BOLD}  Astra Dev Server${RESET}`);
  console.log(`${DIM}  Starting all services...${RESET}\n`);

  const services: ServiceConfig[] = [
    {
      name: "gateway",
      color: COLORS.gateway,
      command: "npx",
      args: ["tsx", "watch", "--env-file", ".env", "src/gateway/index.ts"],
      cwd: rootDir,
    },
  ];

  // Only add dashboard if it exists
  try {
    await access(join(dashboardDir, "package.json"));
    services.push({
      name: "dashboard",
      color: COLORS.dashboard,
      command: "npm",
      args: ["run", "dev"],
      cwd: dashboardDir,
    });
  } catch {
    console.log(`${prefix("system", COLORS.system)} Dashboard not found, skipping`);
  }

  // Optional: add typecheck watcher
  const runTypecheck = process.argv.includes("--typecheck");
  if (runTypecheck) {
    services.push({
      name: "typecheck",
      color: COLORS.typecheck,
      command: "npx",
      args: ["tsc", "--watch", "--noEmit", "--preserveWatchOutput"],
      cwd: rootDir,
      optional: true,
    });
  }

  const children: ChildProcess[] = [];

  for (const svc of services) {
    console.log(`${prefix(svc.name, svc.color)} Starting...`);

    const child = spawn(svc.command, svc.args, {
      cwd: svc.cwd ?? rootDir,
      env: { ...process.env, ...svc.env, FORCE_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    child.stdout?.on("data", (data: Buffer) => logLine(svc.name, svc.color, data.toString()));
    child.stderr?.on("data", (data: Buffer) => logLine(svc.name, svc.color, data.toString()));

    child.on("exit", (code: number | null) => {
      if (code !== null && code !== 0 && !svc.optional) {
        console.log(`${prefix(svc.name, svc.color)} ${"\x1b[31m"}Exited with code ${code}${RESET}`);
      }
    });

    children.push(child);
  }

  console.log(`\n${prefix("system", COLORS.system)} All services started. Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n${prefix("system", COLORS.system)} Shutting down...`);
    for (const child of children) {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) child.kill("SIGKILL");
      }
      process.exit(0);
    }, 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise(() => {});
}
