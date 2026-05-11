-- Create table for synthetic transaction benchmark results
CREATE TABLE synthetic_tx_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  latency_ms integer NOT NULL,
  success boolean NOT NULL,
  error text,
  run_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient queries by provider and run time
CREATE INDEX idx_synthetic_tx_results_provider_run_at ON synthetic_tx_results(provider, run_at DESC);
