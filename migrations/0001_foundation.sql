PRAGMA foreign_keys = ON;

CREATE TABLE locations (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(updated_at >= created_at)
);
CREATE TABLE users (
 id TEXT PRIMARY KEY NOT NULL,
 username TEXT NOT NULL UNIQUE CHECK(length(trim(username)) BETWEEN 1 AND 100),
 password_hash TEXT NOT NULL CHECK(length(password_hash) > 0),
 role TEXT NOT NULL CHECK(role IN ('ADMIN','OFFICER')),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(updated_at >= created_at)
);
CREATE TABLE user_sessions (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX user_sessions_user_expiry ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- Expired sessions do not occupy the officer slot. No client policy flag exists.
CREATE TRIGGER user_sessions_insert_guard BEFORE INSERT ON user_sessions BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1)
 THEN RAISE(ABORT,'Inactive session user') END;
 SELECT CASE WHEN NEW.revoked_at IS NULL AND NEW.expires_at > unixepoch()
 AND (SELECT role FROM users WHERE id=NEW.user_id)='OFFICER'
 AND EXISTS (SELECT 1 FROM user_sessions WHERE user_id=NEW.user_id AND revoked_at IS NULL AND expires_at > unixepoch())
 THEN RAISE(ABORT,'Officer session limit') END;
END;
CREATE TRIGGER user_sessions_immutable BEFORE UPDATE ON user_sessions BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.token_hash IS NOT OLD.token_hash
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
 THEN RAISE(ABORT,'Session is immutable except first revocation') END;
END;
CREATE TRIGGER users_officer_transition BEFORE UPDATE OF role ON users
WHEN NEW.role='OFFICER' AND (SELECT count(*) FROM user_sessions WHERE user_id=OLD.id AND revoked_at IS NULL AND expires_at > unixepoch()) > 1
BEGIN SELECT RAISE(ABORT,'Revoke excess sessions before officer transition'); END;
CREATE TRIGGER users_deactivate AFTER UPDATE OF is_active ON users WHEN NEW.is_active=0 BEGIN
 UPDATE user_sessions SET revoked_at=max(unixepoch(),created_at) WHERE user_id=NEW.id AND revoked_at IS NULL;
END;

CREATE TABLE raid_sessions (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
 lane TEXT NOT NULL CHECK(length(trim(lane)) BETWEEN 1 AND 100),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
 started_at INTEGER NOT NULL DEFAULT (unixepoch()),
 closed_at INTEGER,
 UNIQUE(id,user_id),
 CHECK((status='ACTIVE' AND closed_at IS NULL) OR (status='CLOSED' AND closed_at IS NOT NULL AND closed_at >= started_at))
);
CREATE UNIQUE INDEX raid_sessions_one_active ON raid_sessions(user_id) WHERE status='ACTIVE';
CREATE INDEX raid_sessions_location_time ON raid_sessions(location_id,started_at);
CREATE TRIGGER raid_sessions_start_guard BEFORE INSERT ON raid_sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM locations WHERE id=NEW.location_id AND is_active=1)
 OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1)
 THEN RAISE(ABORT,'Inactive raid location or user') END;
END;
CREATE TRIGGER raid_sessions_identity_guard BEFORE UPDATE ON raid_sessions BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.location_id IS NOT OLD.location_id
 OR NEW.started_at IS NOT OLD.started_at OR NEW.lane IS NOT OLD.lane
 OR (OLD.status='CLOSED' AND (NEW.status IS NOT OLD.status OR NEW.closed_at IS NOT OLD.closed_at))
 THEN RAISE(ABORT,'Raid identity or closed state is immutable') END;
END;

CREATE TABLE check_logs (
 id TEXT PRIMARY KEY NOT NULL,
 raid_session_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 nopol TEXT NOT NULL CHECK(length(nopol) BETWEEN 2 AND 9 AND nopol NOT GLOB '*[^A-Z0-9]*'),
 outcome TEXT NOT NULL CHECK(outcome IN ('FOUND','NOT_FOUND')),
 tax_status TEXT,
 stnk_status TEXT,
 source TEXT NOT NULL CHECK(source IN ('LIVE','CACHE')),
 checked_at INTEGER NOT NULL DEFAULT (unixepoch()),
 FOREIGN KEY(raid_session_id,user_id) REFERENCES raid_sessions(id,user_id) ON DELETE RESTRICT,
 UNIQUE(raid_session_id,idempotency_key),
 CHECK((outcome='FOUND' AND tax_status IS NOT NULL AND stnk_status IS NOT NULL
 AND tax_status IN ('ACTIVE','EXPIRED','UNKNOWN') AND stnk_status IN ('ACTIVE','EXPIRED','UNKNOWN'))
 OR (outcome='NOT_FOUND' AND tax_status IS NULL AND stnk_status IS NULL AND source='LIVE'))
);
CREATE INDEX check_logs_raid_time ON check_logs(raid_session_id,checked_at);
CREATE INDEX check_logs_user_time ON check_logs(user_id,checked_at);

-- Authoritative expiry/cookie/CSRF checks remain the Phase 2 request contract.
-- Log writes never accept inactive users. No input-cycle sealing policy is introduced.
CREATE TRIGGER check_logs_active_user BEFORE INSERT ON check_logs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1)
 THEN RAISE(ABORT,'Inactive check user') END;
END;

CREATE TABLE admin_audit_logs (
 id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('USER_CREATED','USER_UPDATED','USER_DEACTIVATED','SESSION_REVOKED','LOCATION_CREATED','LOCATION_UPDATED','LOCATION_DEACTIVATED')),
 target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
 target_session_id TEXT REFERENCES user_sessions(id) ON DELETE RESTRICT,
 target_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
 occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
 CHECK((action IN ('USER_CREATED','USER_UPDATED','USER_DEACTIVATED') AND target_user_id IS NOT NULL AND target_session_id IS NULL AND target_location_id IS NULL)
 OR (action='SESSION_REVOKED' AND target_session_id IS NOT NULL AND target_user_id IS NULL AND target_location_id IS NULL)
 OR (action IN ('LOCATION_CREATED','LOCATION_UPDATED','LOCATION_DEACTIVATED') AND target_location_id IS NOT NULL AND target_user_id IS NULL AND target_session_id IS NULL))
);
CREATE INDEX admin_audit_logs_actor_time ON admin_audit_logs(actor_user_id,occurred_at);
CREATE TRIGGER admin_audit_logs_actor_guard BEFORE INSERT ON admin_audit_logs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_user_id AND role='ADMIN' AND is_active=1)
 THEN RAISE(ABORT,'Active admin required') END;
END;
