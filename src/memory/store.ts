import { getPool } from "../config/postgres.js";
import type { DailyMemoryDoc, DailyMemoryEntry, MemoryProfile } from "./types.js";

// ── Daily Memory ────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateKeyOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function buildLookbackKeys(lookbackDays: number): string[] {
  return Array.from({ length: lookbackDays }, (_, i) => dateKeyOffset(i));
}

export async function getDailyEntryCount(
  uid: string,
  date: string,
  workspaceId?: string,
): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ entries: DailyMemoryEntry[] }>(
    `SELECT entries FROM daily_memory
     WHERE user_id = $1 AND date = $2 AND workspace_id IS NOT DISTINCT FROM $3`,
    [uid, date, workspaceId ?? null],
  );

  if (rows.length === 0) return 0;
  return (rows[0]!.entries as DailyMemoryEntry[]).length;
}

export async function appendDailyMemory(
  uid: string,
  entry: DailyMemoryEntry,
  workspaceId?: string,
  namespace?: string,
): Promise<void> {
  const pool = getPool();
  const key = todayKey();
  const ns = namespace ?? "default";

  await pool.query(
    `INSERT INTO daily_memory (user_id, workspace_id, date, entries, updated_at, namespace)
     VALUES ($1, $2, $3, $4::jsonb, NOW(), $5)
     ON CONFLICT (user_id, workspace_id, date)
     DO UPDATE SET entries = daily_memory.entries || $4::jsonb, updated_at = NOW()`,
    [uid, workspaceId ?? null, key, JSON.stringify([entry]), ns],
  );
}

export async function loadRecentDailyMemory(
  uid: string,
  workspaceId?: string,
  lookbackDays: number = 7,
  namespace?: string,
): Promise<DailyMemoryDoc[]> {
  const pool = getPool();
  const keys = buildLookbackKeys(lookbackDays);

  const nsFilter = namespace ? ` AND namespace = $4` : "";
  const params: unknown[] = [uid, keys, workspaceId ?? null];
  if (namespace) params.push(namespace);

  const { rows } = await pool.query<{
    id: string;
    date: string;
    entries: DailyMemoryEntry[];
    updated_at: string;
  }>(
    `SELECT id, date, entries, updated_at FROM daily_memory
     WHERE user_id = $1 AND date = ANY($2::date[])
       AND workspace_id IS NOT DISTINCT FROM $3${nsFilter}
     ORDER BY date ASC`,
    params,
  );

  // Fire-and-forget: increment access_count for retrieved rows
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    pool.query(
      `UPDATE daily_memory SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids],
    ).catch(() => {});
  }

  return rows.map((r) => {
    const allEntries = r.entries as DailyMemoryEntry[];
    // Apply effective weight (explicit weight field takes precedence, else 1.0)
    const weighted = allEntries
      .map((e) => ({ ...e, weight: e.weight ?? 1.0 }))
      .filter((e) => e.weight >= 0.2)
      .sort((a, b) => (b.weight ?? 1.0) - (a.weight ?? 1.0));

    return {
      date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
      entries: weighted,
      updatedAt: new Date(r.updated_at).getTime(),
    };
  });
}

// ── Long-Term Profile ───────────────────────────────────────────────

export async function loadProfile(
  uid: string,
  workspaceId?: string,
): Promise<MemoryProfile | null> {
  const pool = getPool();
  const wsId = workspaceId ?? "00000000-0000-0000-0000-000000000000";

  const { rows } = await pool.query<{ profile_data: MemoryProfile }>(
    `SELECT profile_data FROM memory_profiles
     WHERE user_id = $1 AND COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) = $2::uuid`,
    [uid, wsId],
  );

  return rows.length > 0 ? rows[0]!.profile_data as MemoryProfile : null;
}

export async function updateProfile(
  uid: string,
  updates: Partial<MemoryProfile>,
  workspaceId?: string,
): Promise<void> {
  const pool = getPool();
  const wsId = workspaceId ?? null;

  // Load existing profile to merge
  const existing = await loadProfile(uid, workspaceId);
  const merged = {
    strategicNotes: [],
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };

  await pool.query(
    `INSERT INTO memory_profiles (user_id, workspace_id, profile_data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET profile_data = $3::jsonb, updated_at = NOW()`,
    [uid, wsId, JSON.stringify(merged)],
  );
}
