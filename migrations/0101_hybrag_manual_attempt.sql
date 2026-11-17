-- Pending status must identify the generation accepted for this run.
ALTER TABLE hybrag_manual_runs ADD COLUMN pending_attempt TEXT NOT NULL DEFAULT '';
