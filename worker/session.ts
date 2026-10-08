import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { AppError } from '../shared/errors';
import { encodeBase64Url } from '../shared/password';
import { readAuthConfig } from './config';
import type { AppEnv, AuthContext, Role } from './types';

export const SESSION_COOKIE_NAME = '__Host-rs_session';
// 32 random bytes encoded as unpadded base64url.
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export function generateSessionToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export type CookieToken = { present: boolean; token: string | null };

/** Reads the session cookie. A present but malformed value is reported as present with no token. */
export function readSessionCookie(c: Context<AppEnv>): CookieToken {
  const header = c.req.header('Cookie');
  if (!header || !header.includes(SESSION_COOKIE_NAME)) return { present: false, token: null };
  const value = getCookie(c, SESSION_COOKIE_NAME);
  return { present: true, token: typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value) ? value : null };
}

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAgeSeconds: number): void {
  c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${COOKIE_ATTRIBUTES}`, { append: true });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`, { append: true });
}

type SessionRow = { session_id: string; expires_at: number; user_id: string; username: string; role: Role };

/** Session lookup always reads revocation, expiry (D1 clock), user activity and role from D1. No cache. */
export async function findActiveSession(db: D1Database, token: string): Promise<AuthContext | null> {
  const row = await db.prepare(`SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.role
    FROM user_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch() AND u.is_active = 1`)
    .bind(await hashSessionToken(token)).first<SessionRow>();
  if (!row || (row.role !== 'ADMIN' && row.role !== 'OFFICER')) return null;
  return { sessionId: row.session_id, userId: row.user_id, username: row.username, role: row.role, expiresAt: row.expires_at };
}

export const requireAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  // Fail closed on invalid auth configuration for every authenticated route, not only login.
  readAuthConfig(c.env);
  const cookie = readSessionCookie(c);
  const auth = cookie.token ? await findActiveSession(c.env.DB, cookie.token) : null;
  if (!auth) {
    if (cookie.present) clearSessionCookie(c);
    throw new AppError('AUTHENTICATION_ERROR');
  }
  c.set('auth', auth);
  return next();
};

export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  if (!auth) throw new AppError('AUTHENTICATION_ERROR');
  if (!roles.includes(auth.role)) throw new AppError('AUTHORIZATION_ERROR');
  return next();
};

export function currentAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw new AppError('AUTHENTICATION_ERROR');
  return auth;
}
