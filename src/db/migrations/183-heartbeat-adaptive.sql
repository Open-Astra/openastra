-- Add adaptive interval support to heartbeat configuration
ALTER TABLE heartbeat_configs ADD COLUMN adaptive_min_interval_minutes integer;
ALTER TABLE heartbeat_configs ADD COLUMN adaptive_max_interval_minutes integer;
ALTER TABLE heartbeat_configs ADD COLUMN current_interval_minutes integer;
