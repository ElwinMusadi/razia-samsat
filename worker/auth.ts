import type { Context } from 'hono';
import { AppError } from '../shared/errors';
import { dummyVerifyPassword, hashPassword, isAcceptablePassword, verifyPassword } from '../shared/password';
import { normalizeUsername } from '../shared/username';
import { readAuthConfig } from './config';
import { errorMessageIncludes, readJsonObject } from './http';
import type { SafeLogger } from './logger';
import { findActiveRaidSession, type RaidSession } from './raids';
import { clearSessionCookie, currentAuth, generateSessionToken, hashSessionToken, readSessionCookie, requireAuth, setSessionCookie } from './session';
import type { App, AppEnv, AuthContext, Role } from './types';

/** API AuthState. `session.expires_at` is integer Unix epoch seconds (UTC) from the D1 clock. */
export type AuthState = { user: { id: string; username: string; role: Role }; session: { expires_at: number }; active_raid_session: RaidSession | null };
type UserRow = { id: string; username: string; password_hash: string; role: string; is_active: number };

async function authState(c: Context<AppEnv>, auth: AuthContext): Promise<AuthState> {
  return {
    user: { id: auth.userId, username: auth.username, role: auth.role },
    session: { expires_at: auth.expiresAt },
    active_raid_session: await findActiveRaidSession(c.env.DB, auth.userId),
  };
}

function rejectCredentials(): never {
  throw new AppError('INVALID_CREDENTIALS');
}

export function registerAuthRoutes(app: App, logger: SafeLogger): void {
  app.post('/api/auth/login', async c => {
    const config = readAuthConfig(c.env);
    const body = await readJsonObject(c);
    const { username: rawUsername, password } = body;
    // Structural errors are account-independent and therefore safe to report as 400.
    if (typeof rawUsername !== 'string' || typeof password !== 'string' || !isAcceptablePassword(password)) throw new AppError('INVALID_INPUT');
    const username = normalizeUsername(rawUsername);
    const user = username === null ? null : await c.env.DB.prepare('SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?').bind(username).first<UserRow>();
    if (!user || user.is_active !== 1 || (user.role !== 'ADMIN' && user.role !== 'OFFICER')) {
      await dummyVerifyPassword(password, config.passwordIterations);
      rejectCredentials();
    }
    const verification = await verifyPassword(password, user.password_hash, config.passwordIterations);
    if (!verification.ok) rejectCredentials();

    const db = c.env.DB;
    const statements: D1PreparedStatement[] = [];
    const upgraded = verification.needsRehash ? await hashPassword(password, config.passwordIterations) : null;
    // Both rotation and insertion require the exact hash that PBKDF2 verified. A concurrent reset
    // must not revoke an otherwise valid cookie or create a session with the obsolete credential.
    const verified = `SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND is_active = 1 AND role IN ('ADMIN','OFFICER')`;
    const cookie = readSessionCookie(c);
    if (cookie.token) {
      statements.push(db.prepare(`UPDATE user_sessions SET revoked_at = max(unixepoch(), created_at) WHERE token_hash = ? AND revoked_at IS NULL AND EXISTS (${verified})`)
        .bind(await hashSessionToken(cookie.token), user.id, user.password_hash));
    }
    const sessionId = crypto.randomUUID();
    const token = generateSessionToken();
    statements.push(db.prepare(`INSERT INTO user_sessions(id, user_id, token_hash, created_at, expires_at)
      SELECT ?, id, ?, unixepoch(), unixepoch() + ? FROM users
      WHERE id = ? AND password_hash = ? AND is_active = 1 AND role IN ('ADMIN','OFFICER')`)
      .bind(sessionId, await hashSessionToken(token), config.sessionTtlSeconds, user.id, user.password_hash));
    // Rehash only after a successful insert; never overwrite a concurrent password reset.
    if (upgraded) statements.push(db.prepare(`UPDATE users SET password_hash = ?, updated_at = max(unixepoch(), created_at)
      WHERE id = ? AND password_hash = ? AND EXISTS (SELECT 1 FROM user_sessions WHERE id = ? AND user_id = users.id)`)
      .bind(upgraded, user.id, user.password_hash, sessionId));
    statements.push(db.prepare(`SELECT s.expires_at, s.expires_at - unixepoch() AS remaining, u.username, u.role
      FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(sessionId));
    let created: { expires_at: number; remaining: number; username: string; role: Role } | undefined;
    try {
      const results = await db.batch(statements);
      created = (results[results.length - 1].results as { expires_at: number; remaining: number; username: string; role: Role }[])[0];
    } catch (error) {
      if (errorMessageIncludes(error, 'Officer session limit')) throw new AppError('SESSION_CONFLICT');
      if (errorMessageIncludes(error, 'Inactive session user')) rejectCredentials();
      throw error;
    }
    if (!created) rejectCredentials();
    setSessionCookie(c, token, created.remaining);
    logger({ event: 'auth_login_succeeded', request_id: c.get('requestId') });
    return c.json(await authState(c, { sessionId, userId: user.id, username: created.username, role: created.role, expiresAt: created.expires_at }));
  });

  // Idempotent: revokes the cookie's session when it is still valid and always clears the cookie.
  app.post('/api/auth/logout', async c => {
    const cookie = readSessionCookie(c);
    if (cookie.token) {
      await c.env.DB.prepare('UPDATE user_sessions SET revoked_at = max(unixepoch(), created_at) WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > unixepoch()')
        .bind(await hashSessionToken(cookie.token)).run();
    }
    clearSessionCookie(c);
    logger({ event: 'auth_logout', request_id: c.get('requestId') });
    return c.body(null, 204);
  });

  app.get('/api/auth/me', requireAuth(), async c => c.json(await authState(c, currentAuth(c))));
}
