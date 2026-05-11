-- 175: Supervisor / specialist round-robin routing counter
CREATE TABLE IF NOT EXISTS agent_round_robin (
  agent_id TEXT PRIMARY KEY,
  count BIGINT NOT NULL DEFAULT 0
);
