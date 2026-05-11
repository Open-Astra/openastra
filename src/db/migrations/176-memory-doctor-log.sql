CREATE TABLE IF NOT EXISTS memory_doctor_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_count INT NOT NULL DEFAULT 0,
  canonicalized_count INT NOT NULL DEFAULT 0
);
