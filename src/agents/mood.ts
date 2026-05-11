import type { Pool } from "pg";
import { getPool } from "../config/postgres.js";

// ── Agent Mood State Machine ──────────────────────────────────────────
// Tracks per-session mood that shifts based on error frequency and
// session length. Used to append a brief tone modifier to the system prompt.
//
// State transitions:
//   neutral  ──(success)──► enthusiastic
//   neutral  ──(error)────► cautious
//   enthusiastic ──(error)─► neutral
//   cautious ──(error)────► cautious  (stays)
//   any      ──(long_session)─► tired

export type AgentMood = "neutral" | "enthusiastic" | "cautious" | "tired";

interface MoodRow {
  mood: AgentMood;
  energy: number;
}

/**
 * Fetch the current mood for a session. Returns 'neutral' if no record exists.
 */
export async function getMood(sessionId: string, pool?: Pool): Promise<AgentMood> {
  const p = pool ?? getPool();
  const { rows } = await p.query<MoodRow>(
    "SELECT mood, energy FROM agent_mood_states WHERE session_id = $1",
    [sessionId],
  );
  return rows[0]?.mood ?? "neutral";
}

/**
 * Updates mood based on the event type and returns the new mood.
 * Uses UPSERT to create the row on first call.
 *
 * Transitions:
 *   success     → energy += 0.1 (cap 1.0); if energy > 0.7 → enthusiastic, else neutral
 *   error       → energy -= 0.2 (floor 0.0); if energy < 0.3 → cautious
 *   long_session → energy -= 0.15; if energy < 0.2 → tired
 */
export async function updateMood(
  sessionId: string,
  event: "error" | "success" | "long_session",
  pool?: Pool,
): Promise<AgentMood> {
  const p = pool ?? getPool();

  // Read current state
  const { rows } = await p.query<MoodRow>(
    "SELECT mood, energy FROM agent_mood_states WHERE session_id = $1",
    [sessionId],
  );

  let energy = rows[0]?.energy ?? 0.5;

  switch (event) {
    case "success":
      energy = Math.min(1.0, energy + 0.1);
      break;
    case "error":
      energy = Math.max(0.0, energy - 0.2);
      break;
    case "long_session":
      energy = Math.max(0.0, energy - 0.15);
      break;
  }

  // Derive new mood from energy level
  let newMood: AgentMood;
  if (energy >= 0.7) {
    newMood = "enthusiastic";
  } else if (energy < 0.2) {
    newMood = event === "long_session" ? "tired" : "cautious";
  } else if (energy < 0.3) {
    newMood = "cautious";
  } else {
    newMood = "neutral";
  }

  // Upsert
  await p.query(
    `INSERT INTO agent_mood_states (session_id, mood, energy, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_id) DO UPDATE
       SET mood = $2, energy = $3, updated_at = NOW()`,
    [sessionId, newMood, energy],
  );

  return newMood;
}

/**
 * Returns a brief tone modifier string to append to the system prompt,
 * based on the current mood state.
 */
export function getMoodSystemSuffix(mood: AgentMood): string {
  switch (mood) {
    case "enthusiastic":
      return "\n[Tone: You are energized and eager to help. Be proactive and positive.]";
    case "cautious":
      return "\n[Tone: Proceed carefully. Double-check your reasoning before responding.]";
    case "tired":
      return "\n[Tone: Keep your responses focused and concise. Avoid unnecessary elaboration.]";
    case "neutral":
    default:
      return "";
  }
}
