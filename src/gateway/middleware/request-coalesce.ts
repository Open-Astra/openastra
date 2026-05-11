import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../../utils/logger.js";
import { getPool } from "../../config/postgres.js";

const log = createLogger("request-coalesce");

interface PendingRequest {
  promise: Promise<{ status: number; body: string; headers: Record<string, string> }>;
  resolve: (v: { status: number; body: string; headers: Record<string, string> }) => void;
  reject: (e: Error) => void;
  count: number;
  createdAt: number;
}

interface PendingSessionRequest {
  promise: Promise<{ status: number; body: string }>;
  resolve: (v: { status: number; body: string }) => void;
  reject: (e: Error) => void;
}

const pending = new Map<string, PendingRequest>();
const sessionPending = new Map<string, PendingSessionRequest>();
const MAX_WAIT_MS = 5_000;
const DEFAULT_WINDOW_MS = 200;

function computeHash(req: Request | string): string {
  if (typeof req === "string") {
    return createHash("sha256").update(req).digest("hex");
  }
  const payload = JSON.stringify({ path: req.path, body: req.body });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Hash a message string for deduplication.
 * @param message - Message content to hash
 */
export function computeMessageHash(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

/**
 * Deduplicate requests at the session level.
 * @param uid - User ID
 * @param agentId - Agent ID
 * @param messageHash - Hash of the message content
 * @param surface - Session surface (slack, http, etc)
 * @param surfaceId - Surface-specific identifier
 * @returns Key for tracking this session request, or null if already in-flight
 */
export async function sessionAwareCoalesce(
  uid: string,
  agentId: string,
  messageHash: string,
  surface: string,
  surfaceId: string,
): Promise<string | null> {
  const key = `${uid}:${agentId}:${messageHash}:${surface}:${surfaceId}`;

  // Check if this exact request is already in-flight
  if (sessionPending.has(key)) {
    log.info(`Session-level coalesce: request already in-flight (${key})`);
    return null;
  }

  // Create a promise for this request
  let resolvePromise!: PendingSessionRequest["resolve"];
  let rejectPromise!: PendingSessionRequest["reject"];
  const promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  sessionPending.set(key, { promise, resolve: resolvePromise, reject: rejectPromise });

  // Auto-cleanup after MAX_WAIT_MS
  setTimeout(() => {
    sessionPending.delete(key);
  }, MAX_WAIT_MS);

  return key;
}

/**
 * Record the resolution of a session-level coalesced request.
 * @param key - The key returned from sessionAwareCoalesce
 * @param status - HTTP status code
 * @param body - Response body
 */
export async function resolveSessionCoalesce(key: string, status: number, body: string): Promise<void> {
  const entry = sessionPending.get(key);
  if (entry) {
    entry.resolve({ status, body });
    sessionPending.delete(key);

    // Persist to database for future deduplication
    try {
      const pool = getPool();
      const [uid, agentId, messageHash, surface, surfaceId] = key.split(":");
      await pool.query(
        `INSERT INTO coalesced_requests (request_hash, uid, agent_id, message_hash, surface, surface_id, response_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [computeHash(`${uid}:${agentId}:${messageHash}`), uid, agentId, messageHash, surface, surfaceId, JSON.stringify({ status, body })],
      );
    } catch (err) {
      log.warn(`Failed to persist coalesced request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Get coalesced request promise if one is in-flight.
 * @param key - The key returned from sessionAwareCoalesce
 */
export function getSessionCoalescePromise(key: string): Promise<{ status: number; body: string }> | null {
  return sessionPending.get(key)?.promise ?? null;
}

export function requestCoalesce(opts?: { windowMs?: number }) {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();

    const hash = computeHash(req);
    const existing = pending.get(hash);

    if (existing && Date.now() - existing.createdAt < windowMs) {
      existing.count++;
      log.info(`Coalescing request ${hash} (${existing.count} total)`);
      existing.promise
        .then((cached) => {
          for (const [k, v] of Object.entries(cached.headers)) {
            res.setHeader(k, v);
          }
          res.setHeader("X-Coalesced", "true");
          res.status(cached.status).send(cached.body);
        })
        .catch(() => {
          res.status(502).json({ error: "Coalesced request failed" });
        });
      return;
    }

    let resolvePromise!: PendingRequest["resolve"];
    let rejectPromise!: PendingRequest["reject"];
    const promise = new Promise<{ status: number; body: string; headers: Record<string, string> }>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );

    const entry: PendingRequest = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      count: 1,
      createdAt: Date.now(),
    };
    pending.set(hash, entry);

    const timeout = setTimeout(() => {
      pending.delete(hash);
      entry.reject(new Error("Coalesce timeout"));
    }, MAX_WAIT_MS);

    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);

    const capture = (body: unknown) => {
      clearTimeout(timeout);
      pending.delete(hash);
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      const headers: Record<string, string> = {};
      const ct = res.getHeader("content-type");
      if (ct) headers["content-type"] = String(ct);
      entry.resolve({ status: res.statusCode, body: bodyStr, headers });
    };

    res.json = ((body: unknown) => {
      capture(body);
      return origJson(body);
    }) as Response["json"];

    res.send = ((body: unknown) => {
      capture(body);
      return origSend(body as string);
    }) as Response["send"];

    next();
  };
}
