-- 108: LLM-distilled key facts from memory
CREATE TABLE IF NOT EXISTS distilled_facts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  fact         TEXT NOT NULL,
  source_count INT NOT NULL DEFAULT 0,     -- how many memories contributed
  confidence   FLOAT NOT NULL DEFAULT 1.0,
  distilled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,                -- null = never
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distilled_facts_user ON distilled_facts (user_id, workspace_id, distilled_at DESC);
