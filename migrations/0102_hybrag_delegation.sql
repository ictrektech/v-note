-- A revoking row keeps its encrypted secret for durable remote revocation retries.
CREATE TABLE hybrag_delegations (
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoking')),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
