CREATE TABLE hybrag_note_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  root_id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_title TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_hybrag_note_tickets_owner_expiry ON hybrag_note_tickets(user_id, expires_at);
