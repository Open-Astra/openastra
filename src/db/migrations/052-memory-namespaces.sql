ALTER TABLE daily_memory ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_daily_memory_namespace ON daily_memory(workspace_id, namespace);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'graph_entities') THEN
    ALTER TABLE graph_entities ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default';
    CREATE INDEX IF NOT EXISTS idx_graph_entities_namespace ON graph_entities(uid, namespace);
  END IF;
END $$;
