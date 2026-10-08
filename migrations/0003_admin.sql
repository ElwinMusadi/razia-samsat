-- No table references admin_audit_logs. Copy historical actors before enabling the current-policy guard.
CREATE TABLE admin_audit_logs_new (
 id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('USER_CREATED','USER_UPDATED','USER_DEACTIVATED','SESSION_REVOKED','LOCATION_CREATED','LOCATION_UPDATED','LOCATION_DEACTIVATED','USER_ACTIVATED','USER_PASSWORD_RESET','USER_SESSIONS_REVOKED')),
 target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
 target_session_id TEXT REFERENCES user_sessions(id) ON DELETE RESTRICT,
 target_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
 occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
 CHECK((action IN ('USER_CREATED','USER_UPDATED','USER_DEACTIVATED','USER_ACTIVATED','USER_PASSWORD_RESET','USER_SESSIONS_REVOKED') AND target_user_id IS NOT NULL AND target_session_id IS NULL AND target_location_id IS NULL)
 OR (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND target_user_id IS NULL AND target_location_id IS NULL)
 OR (action IN ('LOCATION_CREATED','LOCATION_UPDATED','LOCATION_DEACTIVATED') AND target_location_id IS NOT NULL AND target_user_id IS NULL AND target_session_id IS NULL))
);
INSERT INTO admin_audit_logs_new(id,actor_user_id,action,target_user_id,target_session_id,target_location_id,occurred_at)
 SELECT id,actor_user_id,action,target_user_id,target_session_id,target_location_id,occurred_at FROM admin_audit_logs;
DROP TABLE admin_audit_logs;
ALTER TABLE admin_audit_logs_new RENAME TO admin_audit_logs;
CREATE INDEX admin_audit_logs_actor_time ON admin_audit_logs(actor_user_id,occurred_at);
CREATE TRIGGER admin_audit_logs_actor_guard BEFORE INSERT ON admin_audit_logs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_user_id AND role='ADMIN' AND is_active=1)
 THEN RAISE(ABORT,'Active admin required') END;
END;
CREATE TRIGGER admin_audit_logs_immutable BEFORE UPDATE ON admin_audit_logs BEGIN
 SELECT RAISE(ABORT,'Admin audit log is immutable');
END;
CREATE INDEX users_created_id ON users(created_at DESC, id DESC);
