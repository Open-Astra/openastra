-- Extend procedural_memory with full schema
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'workflow';
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS trigger_pattern TEXT NOT NULL DEFAULT '';
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]';
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS execution_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS last_executed_at BIGINT;
ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- Extend memory_branches
ALTER TABLE memory_branches ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_branches ADD COLUMN IF NOT EXISTS parent_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE memory_branches ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE memory_branches ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{"dailyEntries":0,"profileNotes":0,"graphEntities":0}';

-- Branch daily memory (copies of daily_memory for branches)
CREATE TABLE IF NOT EXISTS branch_daily_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID NOT NULL REFERENCES memory_branches(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  date         DATE NOT NULL,
  entries      JSONB NOT NULL DEFAULT '[]',
  UNIQUE (branch_id, user_id, date)
);

-- Branch profiles (copies of memory_profiles for branches)
CREATE TABLE IF NOT EXISTS branch_profiles (
  branch_id    UUID NOT NULL REFERENCES memory_branches(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  profile_data JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (branch_id, user_id)
);

-- Branch graph entities
CREATE TABLE IF NOT EXISTS branch_graph_entities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID NOT NULL REFERENCES memory_branches(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  entity_data  JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_daily_memory_branch ON branch_daily_memory(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_graph_entities_branch ON branch_graph_entities(branch_id);
