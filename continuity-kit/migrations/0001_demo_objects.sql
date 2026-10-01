-- Separate demo database only. No private keys or plaintext workspace contents.
CREATE TABLE ck_demo_objects (
  slot INTEGER NOT NULL CHECK (slot IN (0,1)),
  kind TEXT NOT NULL CHECK (kind IN ('index','blob')),
  object_key TEXT NOT NULL,
  bytes BLOB NOT NULL CHECK (length(bytes) > 0 AND length(bytes) <= 1048576),
  PRIMARY KEY (slot,kind,object_key)
);
CREATE TRIGGER ck_demo_quota BEFORE INSERT ON ck_demo_objects
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM ck_demo_objects WHERE slot=NEW.slot) >= 16
    OR (NEW.kind='index' AND (SELECT COUNT(*) FROM ck_demo_objects WHERE slot=NEW.slot AND kind='index') >= 2)
    OR (SELECT COALESCE(SUM(length(bytes)),0) FROM ck_demo_objects) + length(NEW.bytes) > 16777216
    THEN RAISE(ABORT, 'DEMO_QUOTA') END;
END;
