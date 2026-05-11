// ── Per-User Outbound Webhook Rate Limiter ──────────────────────────
// Sliding window: max 100 webhook dispatches per minute per user.

const WINDOW_MS = 60_000;
const MAX_DISPATCHES = 100;

const store = new Map<string, number[]>();

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [uid, timestamps] of store) {
    const filtered = timestamps.filter((ts) => now - ts < WINDOW_MS);
    if (filtered.length === 0) store.delete(uid);
    else store.set(uid, filtered);
  }
}, WINDOW_MS).unref();

export function checkWebhookRate(uid: string): boolean {
  const now = Date.now();
  let timestamps = store.get(uid);
  if (!timestamps) {
    timestamps = [];
    store.set(uid, timestamps);
  }

  const filtered = timestamps.filter((ts) => now - ts < WINDOW_MS);
  store.set(uid, filtered);

  if (filtered.length >= MAX_DISPATCHES) return false;
  filtered.push(now);
  return true;
}
