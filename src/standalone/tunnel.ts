// ── Astra Tunnel ─────────────────────────────────────────────────────
// Wraps cloudflared to expose the local gateway on a public URL.
// Parses the Trycloudflare URL from cloudflared's stderr output and
// optionally writes PUBLIC_URL to the project's .env file.
//
// Usage: npx astra tunnel [--port <n>] [--write-env]

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOLD, RESET, CYAN, GREEN, RED, DIM, info, success, warn } from "../bin/tui.js";

// ── Constants ───────────────────────────────────────────────────────

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const ENV_FILE = join(process.cwd(), ".env");

// ── Parse CLI flags ─────────────────────────────────────────────────

function parseArgs(): { port: number; writeEnv: boolean } {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let writeEnv = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--write-env") {
      writeEnv = true;
    }
  }

  return { port, writeEnv };
}

// ── Write PUBLIC_URL to .env ────────────────────────────────────────

async function writePublicUrl(url: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(ENV_FILE, "utf8");
  } catch {
    // .env doesn't exist yet — that's fine
  }

  const lines = existing.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("PUBLIC_URL="));

  if (idx >= 0) {
    lines[idx] = `PUBLIC_URL=${url}`;
  } else {
    lines.push(`PUBLIC_URL=${url}`);
  }

  await writeFile(ENV_FILE, lines.join("\n"), "utf8");
}

// ── Check cloudflared is installed ──────────────────────────────────

async function checkCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn("cloudflared", ["--version"], { stdio: "ignore" });
    probe.on("close", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

// ── Main ─────────────────────────────────────────────────────────────

export async function runTunnel(): Promise<void> {
  const { port, writeEnv } = parseArgs();

  console.log(`\n${BOLD}Astra Tunnel${RESET}\n`);

  // Verify cloudflared is available
  const hasCloudflared = await checkCloudflared();
  if (!hasCloudflared) {
    console.error(`${RED}cloudflared not found.${RESET}`);
    console.error(`Install it from: ${CYAN}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${RESET}`);
    console.error(`Or via Homebrew: ${DIM}brew install cloudflared${RESET}`);
    process.exit(1);
  }

  info(`Starting tunnel to http://localhost:${port} ...`);

  let urlFound = false;

  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // cloudflared writes the URL to stderr as a log line
  const onData = async (chunk: Buffer) => {
    const text = chunk.toString();
    const match = TRYCLOUDFLARE_RE.exec(text);

    if (match && !urlFound) {
      urlFound = true;
      const tunnelUrl = match[0];

      console.log(`\n${GREEN}${BOLD}Tunnel active!${RESET}`);
      console.log(`  ${CYAN}${tunnelUrl}${RESET}  → http://localhost:${port}`);
      console.log(`\n${DIM}Your gateway is now publicly reachable.`);
      console.log(`Set this in your Slack/Discord/WhatsApp app's webhook URL.${RESET}`);

      if (writeEnv) {
        try {
          await writePublicUrl(tunnelUrl);
          success(`Written PUBLIC_URL=${tunnelUrl} to .env`);
        } catch (err) {
          warn(`Could not write to .env: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`\n${DIM}Tip: run with ${RESET}${CYAN}--write-env${RESET}${DIM} to persist PUBLIC_URL to .env${RESET}`);
      }

      console.log(`\n${DIM}Press Ctrl+C to stop the tunnel.${RESET}\n`);
    }
  };

  child.stderr.on("data", onData);
  child.stdout.on("data", onData);

  child.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n${RED}cloudflared exited with code ${code}${RESET}`);
      process.exit(code);
    }
  });

  child.on("error", (err) => {
    console.error(`${RED}Failed to start cloudflared: ${err.message}${RESET}`);
    process.exit(1);
  });

  // Forward SIGINT so Ctrl+C cleanly stops cloudflared
  process.on("SIGINT", () => {
    child.kill("SIGINT");
    process.exit(0);
  });

  // Block forever — cloudflared keeps the tunnel alive
  await new Promise<never>(() => {});
}

runTunnel().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
