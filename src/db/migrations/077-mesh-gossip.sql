-- 077-mesh-gossip.sql
-- Agent mesh discovery table for gossip protocol peer registration

CREATE TABLE IF NOT EXISTS mesh_nodes (
  node_id     TEXT        PRIMARY KEY,
  workspace_id UUID       NOT NULL,
  agent_ids   TEXT[]      DEFAULT '{}',
  host        TEXT        NOT NULL,
  port        INT         NOT NULL,
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  metadata    JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mesh_nodes_workspace
  ON mesh_nodes(workspace_id, last_seen DESC);
