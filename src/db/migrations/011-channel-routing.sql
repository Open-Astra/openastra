-- Channel routing: maps channel+chat to a specific agent.
-- Enables per-contact/per-group agent switching via /switch command.

CREATE TABLE IF NOT EXISTS channel_routing (
  channel    TEXT NOT NULL,              -- 'telegram', 'imessage', etc.
  chat_id    TEXT NOT NULL,              -- platform-specific chat ID, or '*' for channel default
  agent_id   TEXT NOT NULL,              -- references agent_configs.id
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_routing_agent ON channel_routing (agent_id);
