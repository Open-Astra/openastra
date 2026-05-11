CREATE TABLE IF NOT EXISTS trace_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  workspace_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  span_type TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}',
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(workspace_id, trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_start ON trace_spans(workspace_id, start_time DESC);
