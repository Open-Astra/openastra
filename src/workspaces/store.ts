import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceDoc,
  WorkspacePlan,
  WorkspaceRole,
} from "./types.js";

// ── Create Workspace ────────────────────────────────────────────────

export async function createWorkspace(
  uid: string,
  name: string,
  plan: WorkspacePlan = "team",
): Promise<WorkspaceDoc> {
  const pool = getPool();
  const id = randomUUID();
  const now = Date.now();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create workspace
    await client.query(
      `INSERT INTO workspaces (id, name, owner_id, plan)
       VALUES ($1, $2, $3, $4)`,
      [id, name, uid, plan],
    );

    // Add creator as owner member
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [id, uid],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    id,
    name,
    ownerId: uid,
    plan,
    createdAt: now,
    settings: {},
  };
}

// ── Get Workspace ───────────────────────────────────────────────────

export async function getWorkspace(
  workspaceId: string,
): Promise<WorkspaceDoc | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    name: string;
    owner_id: string;
    plan: string;
    settings: Record<string, unknown>;
    created_at: string;
  }>(
    "SELECT id, name, owner_id, plan, settings, created_at FROM workspaces WHERE id = $1",
    [workspaceId],
  );

  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    plan: r.plan as WorkspacePlan,
    createdAt: new Date(r.created_at).getTime(),
    settings: r.settings as WorkspaceDoc["settings"],
  };
}

// ── List User Workspaces ────────────────────────────────────────────

export interface WorkspaceMembershipEntry {
  workspaceId: string;
  role: WorkspaceRole;
  workspaceName: string;
  joinedAt: number;
}

export async function listUserWorkspaces(
  uid: string,
): Promise<WorkspaceMembershipEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    workspace_id: string;
    role: string;
    name: string;
    joined_at: string;
  }>(
    `SELECT wm.workspace_id, wm.role, w.name, wm.joined_at
     FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1
     ORDER BY wm.joined_at`,
    [uid],
  );

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    role: r.role as WorkspaceRole,
    workspaceName: r.name,
    joinedAt: new Date(r.joined_at).getTime(),
  }));
}

// ── Add Member ──────────────────────────────────────────────────────

export async function addMember(
  workspaceId: string,
  uid: string,
  role: WorkspaceRole,
  invitedBy: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = $3`,
    [workspaceId, uid, role, invitedBy],
  );
}

// ── Remove Member ───────────────────────────────────────────────────

export async function removeMember(
  workspaceId: string,
  uid: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, uid],
  );
}

// ── Get Member Role ─────────────────────────────────────────────────

export async function getMemberRole(
  workspaceId: string,
  uid: string,
): Promise<WorkspaceRole | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ role: string }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, uid],
  );
  return rows.length > 0 ? (rows[0]!.role as WorkspaceRole) : null;
}

// ── Update Workspace Settings ───────────────────────────────────────

export async function updateWorkspaceSettings(
  workspaceId: string,
  settings: WorkspaceDoc["settings"],
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE workspaces SET settings = $1::jsonb WHERE id = $2",
    [JSON.stringify(settings), workspaceId],
  );
}
