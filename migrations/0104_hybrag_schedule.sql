ALTER TABLE hybrag_settings ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '{"mode":"interval","intervalMinutes":15,"timeZone":"UTC","nightStart":0,"nightEnd":6}';
