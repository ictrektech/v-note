CREATE TABLE hybrag_control_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE hybrag_control_delivery (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  acknowledged_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, workspace_id)
);
