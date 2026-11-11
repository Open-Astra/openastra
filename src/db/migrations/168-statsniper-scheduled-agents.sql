-- Intentionally empty.
--
-- This migration used to seed six deployment-specific scheduled agents
-- (daily sports-news reporters) into every install. Seed data for a specific
-- deployment does not belong in the shared schema history, so the INSERT was
-- removed. The file is kept because migrations are tracked by filename:
-- databases that already applied it are unaffected and keep their rows;
-- new installs get nothing. Define scheduled agents in astra.yml or via the
-- scheduled-agents API instead.
SELECT 1;
