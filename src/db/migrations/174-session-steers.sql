-- 174: Session steering — allows injecting nudges into active agent runs
CREATE TABLE IF NOT EXISTS session_steers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  nudge TEXT NOT NULL,
  append_to_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS session_steers_session_idx ON session_steers(session_id) WHERE consumed_at IS NULL;
