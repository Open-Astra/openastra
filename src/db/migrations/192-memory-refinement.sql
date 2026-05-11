-- Migration 192: Multi-turn memory consolidation and refinement
-- Enables tracking of refined/consolidated memory entries
-- Supports conflict detection and resolution across memory tiers

ALTER TABLE daily_memory ADD COLUMN refined_at timestamptz;
ALTER TABLE daily_memory ADD COLUMN refinement_score numeric(3,2);

CREATE TABLE memory_refinements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid text NOT NULL,
  workspace_id text,
  original_entry_id uuid,
  refined_entry_id uuid,
  conflict_detected boolean DEFAULT false,
  merge_type text, -- 'consolidated', 'superseded', 'contradiction'
  confidence_score numeric(3,2),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_memory_refinements_uid ON memory_refinements(uid, created_at DESC);
CREATE INDEX idx_memory_refinements_workspace ON memory_refinements(workspace_id);
CREATE INDEX idx_memory_refinements_original ON memory_refinements(original_entry_id);
CREATE INDEX idx_memory_refinements_refined ON memory_refinements(refined_entry_id);
