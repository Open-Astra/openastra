DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'graph_entities') THEN
    ALTER TABLE graph_entities ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0;
    CREATE INDEX IF NOT EXISTS graph_entities_confidence_idx ON graph_entities (confidence) WHERE confidence < 0.7;
  END IF;
END $$;
