-- Schema-only custom migration. Keep this trigger as one complete statement.
-- Same quota behavior as migrations/0001_demo_objects.sql; no seed data.
CREATE TRIGGER ck_demo_quota BEFORE INSERT ON ck_demo_objects
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM ck_demo_objects WHERE slot=NEW.slot) >= 16
    OR (NEW.kind='index' AND (SELECT COUNT(*) FROM ck_demo_objects WHERE slot=NEW.slot AND kind='index') >= 2)
    OR (SELECT COALESCE(SUM(length(bytes)),0) FROM ck_demo_objects) + length(NEW.bytes) > 16777216
    THEN RAISE(ABORT, 'DEMO_QUOTA') END;
END;
