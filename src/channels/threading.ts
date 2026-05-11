// Thread-aware session key builder for channel messages.
// Channels that support threads (Slack threads, Discord threads, Telegram topics)
// pass a threadId to get thread-isolated sessions.

export interface ThreadKey {
  uid: string;
  surface: string;
  surfaceId: string;
  threadId?: string; // undefined = main channel, string = thread
}

/**
 * Build a stable session surfaceId that incorporates the threadId.
 * When threadId is present, appends ":thread:{threadId}" so the session
 * stays isolated from the main channel conversation.
 */
export function buildThreadSurfaceId(key: ThreadKey): string {
  const base = key.surfaceId;
  return key.threadId ? `${base}:thread:${key.threadId}` : base;
}

/**
 * Extract thread context from a Slack event payload.
 * Slack threads use thread_ts as the thread identifier.
 */
export function extractSlackThreadId(payload: Record<string, unknown>): string | undefined {
  const event = payload.event as Record<string, unknown> | undefined;
  const threadTs = event?.thread_ts as string | undefined;
  const ts = event?.ts as string | undefined;
  // Only treat as threaded if thread_ts differs from the message's own ts
  return threadTs && threadTs !== ts ? threadTs : undefined;
}

/**
 * Extract thread context from a Discord interaction/message payload.
 * Discord threads are channels with a parent_id.
 */
export function extractDiscordThreadId(channelId: string, parentId?: string): string | undefined {
  // A Discord thread has its own channelId but a parentId pointing to the parent channel
  return parentId ? channelId : undefined;
}

/**
 * Extract thread context from a Telegram update.
 * Telegram Forum topics use message_thread_id.
 */
export function extractTelegramThreadId(update: Record<string, unknown>): string | undefined {
  const msg = (update.message ?? update.callback_query) as Record<string, unknown> | undefined;
  const threadId = msg?.message_thread_id as number | undefined;
  return threadId !== undefined ? String(threadId) : undefined;
}
