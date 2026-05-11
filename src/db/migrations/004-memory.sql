-- Daily memory entries
CREATE TABLE IF NOT EXISTS daily_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  entries      JSONB NOT NULL DEFAULT '[]',
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, workspace_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_memory_user_date ON daily_memory(user_id, date);

-- Long-term memory profiles
CREATE TABLE IF NOT EXISTS memory_profiles (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_data JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, workspace_id)
);

-- Procedural memory
CREATE TABLE IF NOT EXISTS procedural_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'general',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procedural_memory_user ON procedural_memory(user_id);

-- Memory branches
CREATE TABLE IF NOT EXISTS memory_branches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  source_branch_id UUID REFERENCES memory_branches(id),
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  merged_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_branches_user ON memory_branches(user_id);
