CREATE TABLE hybrag_workspace_state (
  workspace_id TEXT PRIMARY KEY,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  pruned_through INTEGER NOT NULL DEFAULT 0
);
INSERT INTO hybrag_workspace_state(workspace_id) SELECT id FROM workspaces;

CREATE TABLE hybrag_source_scopes (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  PRIMARY KEY(user_id,workspace_id,root_id,notebook_id)
);
CREATE TABLE hybrag_source_scope_versions (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  graph_revision INTEGER NOT NULL,
  sync_identity TEXT NOT NULL,
  PRIMARY KEY(user_id,workspace_id,root_id)
);
-- Historical authorized IDs permit tombstones without exposing the new
-- location, title or body of a note that moved outside the selected scope.
CREATE TABLE hybrag_source_members (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  PRIMARY KEY(user_id,workspace_id,root_id,memo_id)
);
CREATE INDEX hybrag_snapshot_note_cursor ON memos(workspace_id,notebook_id,is_deleted,id);

-- Keep triggers on one physical line for remote D1 compatibility.
CREATE TRIGGER hybrag_notebook_graph_insert AFTER INSERT ON notebooks BEGIN INSERT INTO hybrag_workspace_state(workspace_id,graph_revision) VALUES (NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET graph_revision=graph_revision+1; END;
CREATE TRIGGER hybrag_notebook_graph_delete AFTER DELETE ON notebooks BEGIN INSERT INTO hybrag_workspace_state(workspace_id,graph_revision) VALUES (OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET graph_revision=graph_revision+1; END;
CREATE TRIGGER hybrag_notebook_graph_update AFTER UPDATE OF parent_id,is_deleted,workspace_id ON notebooks WHEN NEW.parent_id IS NOT OLD.parent_id OR NEW.is_deleted IS NOT OLD.is_deleted OR NEW.workspace_id IS NOT OLD.workspace_id BEGIN INSERT INTO hybrag_workspace_state(workspace_id,graph_revision) VALUES (OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET graph_revision=graph_revision+1; INSERT INTO hybrag_workspace_state(workspace_id,graph_revision) SELECT NEW.workspace_id,1 WHERE NEW.workspace_id<>OLD.workspace_id ON CONFLICT(workspace_id) DO UPDATE SET graph_revision=graph_revision+1; END;
CREATE TRIGGER hybrag_change_log_pruned AFTER DELETE ON mobile_sync_changes BEGIN INSERT INTO hybrag_workspace_state(workspace_id,pruned_through) VALUES (OLD.workspace_id,OLD.id) ON CONFLICT(workspace_id) DO UPDATE SET pruned_through=MAX(pruned_through,OLD.id); END;
CREATE TRIGGER hybrag_source_scope_cleanup AFTER UPDATE OF version ON hybrag_settings BEGIN DELETE FROM hybrag_source_scopes WHERE user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND root_id NOT IN (SELECT value FROM json_each(NEW.roots_json)); DELETE FROM hybrag_source_scope_versions WHERE user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND root_id NOT IN (SELECT value FROM json_each(NEW.roots_json)); END;
