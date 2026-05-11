// ── Persona Hot-Swap Mid-Conversation ────────────────────────────────
// Change the active persona without losing session context.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("persona-swap");

const PERSONA_COMMAND_RE = /^!persona\s+(\S+)/i;

/**
 * Detect `!persona <name>` in a user message.
 * Returns the persona name or null if the command isn't present.
 */
export function detectPersonaSwapCommand(message: string): string | null {
  const match = PERSONA_COMMAND_RE.exec(message.trim());
  return match ? (match[1] ?? null) : null;
}

/**
 * Persist the active persona override for a session in session metadata.
 */
export async function applyPersonaSwap(
  sessionId: string,
  personaName: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE sessions
     SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{activePersona}',
       $1::jsonb
     )
     WHERE id = $2`,
    [JSON.stringify(personaName), sessionId],
  );
  logger.info(`Session ${sessionId}: persona swapped to "${personaName}"`);
}

/**
 * Read the current persona override from session metadata.
 */
export async function getActivePersona(sessionId: string): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ active_persona: string | null }>(
    `SELECT metadata->>'activePersona' AS active_persona FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.active_persona ?? null;
}

/**
 * Clear the persona override (revert to default persona).
 */
export async function clearPersonaSwap(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE sessions
     SET metadata = metadata - 'activePersona'
     WHERE id = $1`,
    [sessionId],
  );
}
