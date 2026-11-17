ALTER TABLE hybrag_delegations ADD COLUMN secret_hash TEXT;
ALTER TABLE hybrag_delegations ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '';
ALTER TABLE hybrag_delegations ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hybrag_delegations ADD COLUMN target_ready INTEGER NOT NULL DEFAULT 0 CHECK (target_ready IN (0,1));
CREATE UNIQUE INDEX hybrag_delegation_secret ON hybrag_delegations(secret_hash) WHERE secret_hash IS NOT NULL;
CREATE INDEX hybrag_delegation_retry ON hybrag_delegations(next_attempt_at, id);

-- Only a current human request can reserve issuance. Expired reservations are
-- never replayed by a background worker, because issuance has an unknown outcome.
CREATE TABLE hybrag_delegation_issuance (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE hybrag_grant_revocations (
  secret_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX hybrag_grant_revocation_retry ON hybrag_grant_revocations(next_attempt_at,secret_hash);

CREATE TRIGGER hybrag_delegation_revoking AFTER UPDATE OF state ON hybrag_delegations
WHEN NEW.state='revoking' AND OLD.state='active'
BEGIN
  UPDATE hybrag_settings SET enabled=0,version=version+1
    WHERE user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND enabled=1;
END;

CREATE TRIGGER hybrag_settings_stop_delegation AFTER UPDATE OF enabled ON hybrag_settings
WHEN NEW.enabled=0 AND OLD.enabled=1
BEGIN
  UPDATE hybrag_delegations SET state='revoking',version=version+1,next_attempt_at='',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_id=NEW.user_id AND workspace_id=NEW.workspace_id AND state='active';
END;
