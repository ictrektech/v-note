CREATE TABLE hybrag_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  roots_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, workspace_id)
);
ALTER TABLE hybrag_note_tickets ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0;
