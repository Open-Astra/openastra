-- Migration 113: Dead Letter Queue enhancements
-- Adds original_created_at column for tracking when the original job was created.

ALTER TABLE dead_letter_queue ADD COLUMN IF NOT EXISTS original_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dlq_moved_at ON dead_letter_queue(created_at);
