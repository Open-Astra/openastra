CREATE TABLE IF NOT EXISTS team_topic_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS team_channel_subscribers (
  channel_id UUID REFERENCES team_topic_channels(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  subscribed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY(channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS team_channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES team_topic_channels(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tcm_channel ON team_channel_messages (channel_id, created_at DESC);
