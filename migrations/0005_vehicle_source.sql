-- Global vehicle data source (BPAD or Potensi NTT snapshot). Append-only: every row is one change event,
-- so the table is its own audit trail. The active setting is the row with the highest version.
-- The seed row (version 1, BPAD) is the only row without an actor; it is inserted before the guard.
CREATE TABLE vehicle_source_settings (
 version INTEGER PRIMARY KEY NOT NULL CHECK(version >= 1),
 provider TEXT NOT NULL CHECK(provider IN ('BPAD','POTENSI_NTT')),
 updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 CHECK((version = 1 AND updated_by IS NULL) OR (version > 1 AND updated_by IS NOT NULL))
);
INSERT INTO vehicle_source_settings(version, provider, updated_by, updated_at) VALUES (1, 'BPAD', NULL, unixepoch());
-- Compare-and-set: the next version must be exactly max+1, authored by an active ADMIN, and change the provider.
CREATE TRIGGER vehicle_source_settings_insert_guard BEFORE INSERT ON vehicle_source_settings BEGIN
 SELECT CASE WHEN NEW.version IS NOT (SELECT max(version) + 1 FROM vehicle_source_settings)
 THEN RAISE(ABORT,'Vehicle source version conflict') END;
 SELECT CASE WHEN NEW.provider IS (SELECT provider FROM vehicle_source_settings ORDER BY version DESC LIMIT 1)
 THEN RAISE(ABORT,'Vehicle source unchanged') END;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.updated_by AND role = 'ADMIN' AND is_active = 1)
 THEN RAISE(ABORT,'Active admin required') END;
 SELECT CASE WHEN NEW.updated_at < (SELECT max(updated_at) FROM vehicle_source_settings)
 THEN RAISE(ABORT,'Vehicle source clock regression') END;
END;
CREATE TRIGGER vehicle_source_settings_immutable BEFORE UPDATE ON vehicle_source_settings BEGIN
 SELECT RAISE(ABORT,'Vehicle source setting is immutable');
END;
-- Deleting the newest row would silently re-activate an older provider without an audit record.
CREATE TRIGGER vehicle_source_settings_append_only BEFORE DELETE ON vehicle_source_settings BEGIN
 SELECT RAISE(ABORT,'Vehicle source history is append-only');
END;

-- Honest provenance per lookup. Rows recorded before this migration keep NULL and are never reattributed.
ALTER TABLE check_logs ADD COLUMN provider TEXT CHECK(provider IS NULL OR provider IN ('BPAD','POTENSI_NTT'));
