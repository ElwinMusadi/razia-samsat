-- The first statement fails closed on existing duplicates before any schema guard changes.
CREATE UNIQUE INDEX check_logs_raid_nopol ON check_logs(raid_session_id, nopol);

-- Authorized snapshots may finish after deactivation; ownership and existence remain FK guarded.
DROP TRIGGER check_logs_active_user;
CREATE TRIGGER check_logs_immutable BEFORE UPDATE ON check_logs BEGIN
 SELECT RAISE(ABORT, 'Check log is immutable');
END;

DROP INDEX check_logs_raid_time;
CREATE INDEX check_logs_raid_checked_id ON check_logs(raid_session_id, checked_at DESC, id DESC);
CREATE INDEX raid_sessions_user_started_id ON raid_sessions(user_id, started_at DESC, id DESC);
CREATE INDEX raid_sessions_started_id ON raid_sessions(started_at DESC, id DESC);
