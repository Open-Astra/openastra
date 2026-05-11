// ── Docker Container Lifecycle ──────────────────────────────────────
// Manages astra-postgres and astra-typesense as standalone containers
// with named volumes. No docker-compose dependency.

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AstraCliConfig } from "./config.js";

const execFile = promisify(execFileCb);

// ── Container Names & Volumes ───────────────────────────────────────

const PG_CONTAINER = "astra-postgres";
const TS_CONTAINER = "astra-typesense";
const PG_VOLUME = "astra-pgdata";
const TS_VOLUME = "astra-tsdata";

const PG_IMAGE = "pgvector/pgvector:pg17";
const TS_IMAGE = "typesense/typesense:27.1";

// ── Docker Check ────────────────────────────────────────────────────

export async function checkDocker(): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFile("docker", ["version", "--format", "{{.Server.Version}}"]);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("not recognized")) {
      return { ok: false, error: "Docker is not installed. Install it from https://docker.com" };
    }
    if (msg.includes("Cannot connect") || msg.includes("daemon")) {
      return { ok: false, error: "Docker daemon is not running. Start Docker Desktop or the Docker service." };
    }
    return { ok: false, error: `Docker check failed: ${msg}` };
  }
}

// ── Container Status ────────────────────────────────────────────────

export interface ServiceStatus {
  postgres: "running" | "stopped" | "missing";
  typesense: "running" | "stopped" | "missing";
}

async function containerState(name: string): Promise<"running" | "stopped" | "missing"> {
  try {
    const { stdout } = await execFile("docker", [
      "inspect", "--format", "{{.State.Running}}", name,
    ]);
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const [postgres, typesense] = await Promise.all([
    containerState(PG_CONTAINER),
    containerState(TS_CONTAINER),
  ]);
  return { postgres, typesense };
}

// ── Pull Image (with progress output) ───────────────────────────────

function pullImage(image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["pull", image], { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker pull ${image} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function ensureImage(image: string): Promise<void> {
  try {
    await execFile("docker", ["image", "inspect", image]);
  } catch {
    // Image not found locally — pull it
    await pullImage(image);
  }
}

// ── Start Services ──────────────────────────────────────────────────
// Idempotent: creates if missing, starts if stopped, skips if running.

export async function startServices(config: AstraCliConfig): Promise<void> {
  const status = await getServiceStatus();

  // ── Postgres ──────────────────────────────────────────────────────
  if (status.postgres === "missing") {
    await ensureImage(PG_IMAGE);
    await execFile("docker", [
      "run", "-d",
      "--name", PG_CONTAINER,
      "-v", `${PG_VOLUME}:/var/lib/postgresql/data`,
      "-e", `POSTGRES_USER=astra`,
      "-e", `POSTGRES_PASSWORD=${config.pgPassword}`,
      "-e", `POSTGRES_DB=astra`,
      "-p", `${config.pgPort}:5432`,
      "--restart", "unless-stopped",
      PG_IMAGE,
    ]);
  } else if (status.postgres === "stopped") {
    await execFile("docker", ["start", PG_CONTAINER]);
  }

  // ── Typesense ─────────────────────────────────────────────────────
  if (status.typesense === "missing") {
    await ensureImage(TS_IMAGE);
    await execFile("docker", [
      "run", "-d",
      "--name", TS_CONTAINER,
      "-v", `${TS_VOLUME}:/data`,
      "-e", `TYPESENSE_API_KEY=${config.typesenseApiKey}`,
      "-e", "TYPESENSE_DATA_DIR=/data",
      "-p", `${config.typesensePort}:8108`,
      "--restart", "unless-stopped",
      TS_IMAGE,
    ]);
  } else if (status.typesense === "stopped") {
    await execFile("docker", ["start", TS_CONTAINER]);
  }
}

// ── Health Checks ───────────────────────────────────────────────────

async function waitForPostgres(_port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFile("docker", [
        "exec", PG_CONTAINER, "pg_isready", "-U", "astra",
      ]);
      if (stdout.includes("accepting connections")) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`PostgreSQL did not become healthy within ${timeoutMs / 1000}s`);
}

async function waitForTypesense(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Use Node.js built-in fetch (available in Node 20+)
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Typesense did not become healthy within ${timeoutMs / 1000}s`);
}

export async function waitForHealthy(config: AstraCliConfig, timeoutMs = 60_000): Promise<void> {
  await Promise.all([
    waitForPostgres(config.pgPort, timeoutMs),
    waitForTypesense(config.typesensePort, timeoutMs),
  ]);
}

// ── Stop Services ───────────────────────────────────────────────────

export async function stopServices(): Promise<void> {
  const status = await getServiceStatus();
  const stops: Promise<unknown>[] = [];
  if (status.postgres === "running") stops.push(execFile("docker", ["stop", PG_CONTAINER]));
  if (status.typesense === "running") stops.push(execFile("docker", ["stop", TS_CONTAINER]));
  await Promise.all(stops);
}

// ── Remove Services (stop + remove containers + volumes) ────────────

export async function removeServices(): Promise<void> {
  // Stop first
  await stopServices();

  // Remove containers (ignore errors if already gone)
  const removeContainer = async (name: string) => {
    try { await execFile("docker", ["rm", "-f", name]); } catch { /* already gone */ }
  };
  const removeVolume = async (name: string) => {
    try { await execFile("docker", ["volume", "rm", name]); } catch { /* already gone */ }
  };

  await Promise.all([
    removeContainer(PG_CONTAINER),
    removeContainer(TS_CONTAINER),
  ]);
  await Promise.all([
    removeVolume(PG_VOLUME),
    removeVolume(TS_VOLUME),
  ]);
}
