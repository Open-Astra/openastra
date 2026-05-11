-- 028: Per-workspace model restrictions (recommendation 21)
-- Workspaces can restrict which providers and models agents may use.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS allowed_providers JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS allowed_models    JSONB DEFAULT NULL;

-- NULL means unrestricted. A non-null array restricts to those values only.
-- e.g. allowed_providers = '["claude","openai"]'
--      allowed_models = '["claude-opus-4-6","gpt-4o"]'

COMMENT ON COLUMN workspaces.allowed_providers IS 'NULL = any provider; array = restrict to listed provider IDs';
COMMENT ON COLUMN workspaces.allowed_models    IS 'NULL = any model; array = restrict to listed model IDs';
