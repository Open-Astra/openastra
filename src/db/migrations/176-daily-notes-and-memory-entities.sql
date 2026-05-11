-- Create daily_notes and memory_entities tables used by the memory subsystem.
-- daily_notes stores per-user categorized notes (tier 2 memory).
-- memory_entities stores named entities extracted from conversations (tier 4 memory).

CREATE TABLE IF NOT EXISTS daily_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid           TEXT NOT NULL,
  workspace_id  UUID,
  category      TEXT NOT NULL DEFAULT 'note',
  content       TEXT NOT NULL,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  embedding     vector(768),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_notes_uid_date ON daily_notes (uid, date);

CREATE TABLE IF NOT EXISTS memory_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid             TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  entity_type     TEXT NOT NULL DEFAULT 'unknown',
  embedding       vector(768),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_uid ON memory_entities (uid);
