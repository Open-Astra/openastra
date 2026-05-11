import { Agent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

// ── Connection-Pooled HTTP Agents ──────────────────────────────────
// Shared HTTP/HTTPS agents with keep-alive for provider connections.
// Reused across all inference clients to reduce connection overhead.

const httpAgent = new Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30_000,
});

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30_000,
});

export function getHttpAgent(): Agent {
  return httpAgent;
}

export function getHttpsAgent(): HttpsAgent {
  return httpsAgent;
}

export function destroyPools(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}
