-- Memory profile configs (distinct from 004's memory_profiles which stores user profile data).
-- If 004's memory_profiles already exists, add the id column it needs for FK references.

DO $$ BEGIN
  -- Check if memory_profiles exists but lacks an 'id' column (004's schema)
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'memory_profiles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'memory_profiles' AND column_name = 'id') THEN
    ALTER TABLE memory_profiles ADD COLUMN id TEXT DEFAULT gen_random_uuid();
    ALTER TABLE memory_profiles ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE memory_profiles ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE memory_profiles ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE memory_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- Create the table if it doesn't exist at all (fresh DB without 004)
CREATE TABLE IF NOT EXISTS memory_profiles (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS agent_memory_profiles (
  agent_id    TEXT NOT NULL,
  profile_id  TEXT NOT NULL,
  PRIMARY KEY (agent_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_profiles_workspace ON memory_profiles(workspace_id);
