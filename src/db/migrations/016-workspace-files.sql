CREATE TABLE IF NOT EXISTS workspace_files (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename   TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  file_path  TEXT NOT NULL DEFAULT '',
  checksum   TEXT NOT NULL DEFAULT '',
  loaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_files_filename ON workspace_files(filename);
