CREATE TABLE IF NOT EXISTS agent_mood_states (
  session_id TEXT PRIMARY KEY,
  mood TEXT DEFAULT 'neutral',
  energy NUMERIC DEFAULT 0.5,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
