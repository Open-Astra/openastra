-- CRDT-based Memory Merge: operation log for conflict-free memory merging
-- across federated workspaces using LWW-Element-Set with vector clocks.

CREATE TABLE IF NOT EXISTS memory_crdt_ops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  memory_id     TEXT NOT NULL,          -- ID of the memory entry being modified
  memory_table  TEXT NOT NULL,          -- daily_memory | user_memory | entities etc.
  op_type       TEXT NOT NULL,          -- add | remove | update
  field_path    TEXT,                   -- dot-path for field-level CRDT (e.g. 'content', 'metadata.tags')
  value         JSONB,                  -- the value being set
  vector_clock  JSONB NOT NULL,         -- {"workspace_a": 3, "workspace_b": 7}
  origin_workspace TEXT NOT NULL,       -- workspace that originated this op
  origin_node   TEXT,                   -- node ID in mesh topology
  lamport_ts    BIGINT NOT NULL,        -- Lamport timestamp for total ordering
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crdt_ops_memory ON memory_crdt_ops(memory_id, memory_table);
CREATE INDEX IF NOT EXISTS idx_crdt_ops_workspace ON memory_crdt_ops(workspace_id);
CREATE INDEX IF NOT EXISTS idx_crdt_ops_lamport ON memory_crdt_ops(lamport_ts);
CREATE INDEX IF NOT EXISTS idx_crdt_ops_origin ON memory_crdt_ops(origin_workspace);

-- Materialized merge state: latest resolved value per memory field
CREATE TABLE IF NOT EXISTS memory_crdt_state (
  workspace_id  TEXT NOT NULL,
  memory_id     TEXT NOT NULL,
  memory_table  TEXT NOT NULL,
  field_path    TEXT NOT NULL DEFAULT '_root',
  resolved_value JSONB,
  vector_clock  JSONB NOT NULL DEFAULT '{}',
  last_op_id    UUID REFERENCES memory_crdt_ops(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, memory_id, memory_table, field_path)
);
