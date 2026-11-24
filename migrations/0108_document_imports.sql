CREATE TABLE document_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_token TEXT NOT NULL,
  remote_confirmed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued','processing','completed','failed')),
  error_code TEXT,
  memo_id TEXT,
  pages_done INTEGER,
  pages_total INTEGER,
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX document_imports_owner ON document_imports(workspace_id, user_id, created_at DESC);
CREATE INDEX document_imports_pending ON document_imports(state, updated_at);
