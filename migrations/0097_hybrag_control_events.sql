-- The settings change and its control event must commit together. Consumers
-- process versions in order and acknowledge them only after target fencing.
CREATE TABLE hybrag_control_events (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  roots_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, workspace_id, version)
);

INSERT INTO hybrag_control_events (user_id, workspace_id, version, enabled, roots_json)
SELECT user_id, workspace_id, version, enabled, roots_json FROM hybrag_settings;

CREATE TRIGGER hybrag_settings_control_insert AFTER INSERT ON hybrag_settings
BEGIN
  INSERT INTO hybrag_control_events (user_id, workspace_id, version, enabled, roots_json)
  VALUES (NEW.user_id, NEW.workspace_id, NEW.version, NEW.enabled, NEW.roots_json);
END;

CREATE TRIGGER hybrag_settings_control_update AFTER UPDATE OF version ON hybrag_settings
WHEN NEW.version > OLD.version
BEGIN
  INSERT INTO hybrag_control_events (user_id, workspace_id, version, enabled, roots_json)
  VALUES (NEW.user_id, NEW.workspace_id, NEW.version, NEW.enabled, NEW.roots_json);
END;
