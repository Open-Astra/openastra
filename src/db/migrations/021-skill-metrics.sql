CREATE TABLE IF NOT EXISTS skill_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  duration_ms INT NOT NULL,
  error TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS skill_metrics_skill_id_idx ON skill_metrics (skill_id);
CREATE INDEX IF NOT EXISTS skill_metrics_uid_idx ON skill_metrics (uid);
CREATE INDEX IF NOT EXISTS skill_metrics_timestamp_idx ON skill_metrics (timestamp DESC);
