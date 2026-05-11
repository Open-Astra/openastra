import type { Notification } from "pg";
import { getPool } from "../config/postgres.js";
import { cascadeInvalidation, type CascadeOptions } from "./invalidation-cascade.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cache-bus");

/**
 * Notify all connected listeners of a cache invalidation event.
 * Uses PostgreSQL NOTIFY to broadcast the invalidation cascade options to listening clients.
 */
export async function notifyInvalidation(opts: CascadeOptions): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      "SELECT pg_notify($1, $2)",
      ["cache_invalidation", JSON.stringify(opts)],
    );
  } catch (err) {
    log.warn(`Failed to notify invalidation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Start listening for cache invalidation events on the 'cache_invalidation' channel.
 * Each notification triggers cascadeInvalidation() to evict affected caches.
 * This should be called once during startup.
 */
export function startInvalidationListener(): void {
  try {
    const pool = getPool();

    // Issue LISTEN command on the pool (applies to all connections)
    pool.query("LISTEN cache_invalidation").catch((err) => {
      log.warn(
        `Failed to start LISTEN on cache_invalidation: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    // Handle notifications from any connection in the pool
    const handleNotification = (msg: Notification) => {
      if (msg.channel !== "cache_invalidation") return;

      try {
        const opts: CascadeOptions = JSON.parse(msg.payload || "{}");
        cascadeInvalidation(opts).catch((err) => {
          log.warn(
            `Cascade invalidation from notification failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } catch (parseErr) {
        log.warn(
          `Failed to parse cache invalidation payload: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }
    };

    // Register listener on the pool
    (pool as any).on("notification", handleNotification);

    log.info("Cache invalidation listener started");
  } catch (err) {
    log.warn(
      `Failed to start cache invalidation listener: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
