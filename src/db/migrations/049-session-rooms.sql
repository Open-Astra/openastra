-- Session rooms for multi-user collaboration

CREATE TABLE IF NOT EXISTS session_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_room_members (
  room_id UUID NOT NULL REFERENCES session_rooms(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_session_rooms_workspace ON session_rooms(workspace_id, session_id);
