CREATE TABLE IF NOT EXISTS api_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','deprecated','sunset')),
  released_at TIMESTAMPTZ DEFAULT now(),
  deprecated_at TIMESTAMPTZ,
  sunset_at TIMESTAMPTZ,
  changelog TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_version_pins (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  pinned_version TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO api_versions (version, status) VALUES ('v1', 'active') ON CONFLICT DO NOTHING;
