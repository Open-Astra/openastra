-- Migration 083: Session deduplication
-- Tracks merged sessions so duplicate conversations can be consolidated.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS merged_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_merged ON sessions(merged_into) WHERE merged_into IS NOT NULL;
