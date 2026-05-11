-- Migration 185: Request dedup tracking for request coalescing
-- Tracks deduplicated requests to prevent redundant inference calls
-- Indexed for fast lookups by uid and creation time

CREATE TABLE request_dedup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uid text NOT NULL,
  agent_id text NOT NULL,
  message_hash text NOT NULL,
  surface text NOT NULL,
  surface_id text NOT NULL,
  response_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(uid, agent_id, message_hash, surface, surface_id)
);

CREATE INDEX idx_request_dedup_uid_created ON request_dedup(uid, created_at DESC);
