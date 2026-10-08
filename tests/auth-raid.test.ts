import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../shared/password';
import { createApp } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken, requireAuth, requireRole } from '../worker/session';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

// Layer A: Hono app in Node with a real workerd D1 database (Miniflare). Synthetic accounts only.
const ORIGIN = 'https://app.test';
const PASSWORD = 'Synthetic-Pass-123';
const ITERATIONS = 1000;
const TTL = 43200;
const ID = {
  officer: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222',
  admin: '33333333-3333-4333-8333-333333333333', inactive: '44444444-4444-4444-8444-444444444444',
  location: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', closedLocation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  missingLocation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const COOKIE = /^__Host-rs_session=([A-Za-z0-9_-]{43}); Max-Age=(\d+); Path=\/; HttpOnly; Secure; SameSite=Strict$/;
const CLEARED = '__Host-rs_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';

let mf: Miniflare;
let db: TestD1;
let logLines: string[];
let app: ReturnType<typeof createApp>;
let vars: Record<string, string>;
let dbOverride: D1Database | undefined;

const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
const env = () => ({ DB: dbOverride ?? (db as unknown as D1Database), ...vars }) as unknown as Env;
type Init = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };
function call(path: string, init: Init = {}): Promise<Response> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = method === 'GET' ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (init.cookie !== undefined) headers.Cookie = `__Host-rs_session=${init.cookie}`;
  Object.assign(headers, init.headers);
  for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key];
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  return Promise.resolve(app.request(`${ORIGIN}${path}`, { method, headers, body }, env()));
}
const login = (username: string, password = PASSWORD, cookie?: string, headers?: Record<string, string>) => call('/api/auth/login', { body: { username, password }, cookie, headers });
function tokenOf(response: Response): string {
  const match = COOKIE.exec(response.headers.get('set-cookie') ?? '');
  if (!match) throw new Error('missing session cookie');
  return match[1];
}
async function loginToken(username: string, cookie?: string): Promise<string> {
  const response = await login(username, PASSWORD, cookie);
  expect(response.status).toBe(200);
  return tokenOf(response);
}
async function expectError(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json() as { error: Record<string, unknown> };
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
  expect(body.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
  return body.error;
}
const createRaid = (cookie: string, location_id: unknown = ID.location, lane: unknown = 'Jalur Utara A') => call('/api/raid-sessions', { body: { location_id, lane }, cookie });

beforeAll(async () => { ({ mf, db } = await startMigratedD1()); });
beforeEach(async () => {
  await resetTestD1(db);
  vars = { PASSWORD_PBKDF2_ITERATIONS: String(ITERATIONS), SESSION_TTL_SECONDS: String(TTL), RETENTION_POLICY: 'UNSET' };
  dbOverride = undefined;
  logLines = [];
  app = createApp(createSafeLogger(line => logLines.push(line)));
  // Test-only route for role checks; production exposes no admin endpoint in Phase 2.
  app.get('/api/test/admin-only', requireAuth(), requireRole('ADMIN'), c => c.json({ ok: true }));
  const hash = await hashPassword(PASSWORD, ITERATIONS);
  for (const [id, username, role, active] of [[ID.officer, 'synthetic.officer', 'OFFICER', 1], [ID.other, 'synthetic.other', 'OFFICER', 1], [ID.admin, 'synthetic.admin', 'ADMIN', 1], [ID.inactive, 'synthetic.inactive', 'OFFICER', 0]] as const) {
    await sql('INSERT INTO users(id,username,password_hash,role,is_active) VALUES(?,?,?,?,?)', id, username, hash, role, active);
  }
  await sql('INSERT INTO locations(id,name,is_active) VALUES(?,?,1),(?,?,0)', ID.location, 'Pos Synthetic Oebobo', ID.closedLocation, 'Pos Synthetic Tutup');
});
afterAll(async () => { await mf?.dispose(); });

describe('login', () => {
  it('returns AuthState, sets a hardened cookie and stores only the SHA-256 token hash', async () => {
    const response = await login('  Synthetic.Officer ');
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    const [, token, maxAge] = COOKIE.exec(setCookie) ?? [];
    expect(token).toBeDefined();
    expect(Number(maxAge)).toBeGreaterThanOrEqual(TTL - 1);
    expect(Number(maxAge)).toBeLessThanOrEqual(TTL);
    const body = await response.json() as { user: unknown; session: { expires_at: number }; active_raid_session: unknown };
    expect(body.user).toEqual({ id: ID.officer, username: 'synthetic.officer', role: 'OFFICER' });
    expect(body.active_raid_session).toBeNull();
    const rows = await db.prepare('SELECT token_hash, created_at, expires_at, revoked_at FROM user_sessions').all<{ token_hash: string; created_at: number; expires_at: number; revoked_at: number | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].token_hash).toBe(await hashSessionToken(token));
    expect(rows.results[0].token_hash).not.toContain(token);
    expect(rows.results[0].expires_at - rows.results[0].created_at).toBe(TTL);
    expect(body.session.expires_at).toBe(rows.results[0].expires_at);
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it('responds identically for unknown user, wrong password, inactive user and malformed username', async () => {
    const responses = await Promise.all([login('synthetic.missing'), login('synthetic.officer', 'Wrong-Pass'), login('synthetic.inactive'), login('bad user!'), login('')]);
    const bodies = [];
    for (const response of responses) {
      const error = await expectError(response, 401, 'INVALID_CREDENTIALS');
      expect(response.headers.get('set-cookie')).toBeNull();
      bodies.push({ ...error, request_id: undefined });
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await db.prepare('SELECT count(*) AS n FROM user_sessions').first('n')).toBe(0);
  });
  it('treats a corrupt stored hash as invalid credentials', async () => {
    await sql("UPDATE users SET password_hash='pbkdf2-sha256$1000$broken$broken' WHERE id=?", ID.officer);
    await expectError(await login('synthetic.officer'), 401, 'INVALID_CREDENTIALS');
  });
  it.each([
    ['malformed JSON', '{"username":'], ['array', '[]'], ['missing password', '{"username":"synthetic.officer"}'],
    ['non-string username', '{"username":1,"password":"x"}'], ['empty password', '{"username":"synthetic.officer","password":""}'],
    ['password over 1024 bytes', JSON.stringify({ username: 'synthetic.officer', password: '\u00e9'.repeat(513) })],
  ])('rejects %s with 400 INVALID_INPUT', async (_name, body) => {
    await expectError(await call('/api/auth/login', { body }), 400, 'INVALID_INPUT');
  });
  it('rehashes when stored iterations are below the configured value', async () => {
    vars.PASSWORD_PBKDF2_ITERATIONS = '2000';
    await loginToken('synthetic.admin');
    const stored = await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(ID.admin).first<string>('password_hash');
    expect(stored).toMatch(/^pbkdf2-sha256\$2000\$/);
    expect((await login('synthetic.admin')).status).toBe(200);
  });
  it.each([
    ['iterations above workerd limit', { PASSWORD_PBKDF2_ITERATIONS: '100001' }], ['iterations below minimum', { PASSWORD_PBKDF2_ITERATIONS: '999' }],
    ['non-numeric iterations', { PASSWORD_PBKDF2_ITERATIONS: 'abc' }], ['zero TTL', { SESSION_TTL_SECONDS: '0' }],
    ['TTL above 400 days', { SESSION_TTL_SECONDS: '34560001' }], ['missing TTL', { SESSION_TTL_SECONDS: '' }],
  ])('fails closed with 500 on invalid config: %s', async (_name, override) => {
    const token = await loginToken('synthetic.admin');
    Object.assign(vars, override);
    await expectError(await login('synthetic.admin'), 500, 'INTERNAL_ERROR');
    await expectError(await call('/api/auth/me', { cookie: token }), 500, 'INTERNAL_ERROR');
  });
});

describe('session lifecycle', () => {
  it('validates /me and rejects missing or malformed cookies', async () => {
    const token = await loginToken('synthetic.officer');
    const me = await call('/api/auth/me', { cookie: token });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id: ID.officer, role: 'OFFICER' }, active_raid_session: null });
    const missing = await call('/api/auth/me');
    await expectError(missing, 401, 'AUTHENTICATION_ERROR');
    expect(missing.headers.get('set-cookie')).toBeNull();
    const malformed = await call('/api/auth/me', { cookie: 'not-a-token' });
    await expectError(malformed, 401, 'AUTHENTICATION_ERROR');
    expect(malformed.headers.get('set-cookie')).toBe(CLEARED);
  });
  it('logout revokes, clears, is idempotent and the old token is rejected', async () => {
    const token = await loginToken('synthetic.officer');
    const first = await call('/api/auth/logout', { body: {}, cookie: token });
    expect(first.status).toBe(204);
    expect(first.headers.get('set-cookie')).toBe(CLEARED);
    expect(await db.prepare('SELECT revoked_at FROM user_sessions').first('revoked_at')).toBeGreaterThan(0);
    const second = await call('/api/auth/logout', { body: {}, cookie: token });
    expect(second.status).toBe(204);
    expect(second.headers.get('set-cookie')).toBe(CLEARED);
    expect((await call('/api/auth/logout', { body: {} })).status).toBe(204);
    const reused = await call('/api/auth/me', { cookie: token });
    await expectError(reused, 401, 'AUTHENTICATION_ERROR');
    expect(reused.headers.get('set-cookie')).toBe(CLEARED);
    // Officer slot is free again after logout.
    await loginToken('synthetic.officer');
  });
  it('rejects revoked, expired and deactivated-user sessions', async () => {
    const revoked = await loginToken('synthetic.admin');
    await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE token_hash=?', await hashSessionToken(revoked));
    await expectError(await call('/api/auth/me', { cookie: revoked }), 401, 'AUTHENTICATION_ERROR');
    const expired = generateSessionToken();
    await sql('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,1,2)', crypto.randomUUID(), ID.admin, await hashSessionToken(expired));
    await expectError(await call('/api/auth/me', { cookie: expired }), 401, 'AUTHENTICATION_ERROR');
    const officer = await loginToken('synthetic.officer');
    await sql('UPDATE users SET is_active=0 WHERE id=?', ID.officer);
    const response = await call('/api/auth/me', { cookie: officer });
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toBe(CLEARED);
  });
  it('reads role from D1 on every request', async () => {
    const token = await loginToken('synthetic.admin');
    expect((await call('/api/test/admin-only', { cookie: token })).status).toBe(200);
    await sql("UPDATE users SET role='OFFICER' WHERE id=?", ID.admin);
    await expectError(await call('/api/test/admin-only', { cookie: token }), 403, 'AUTHORIZATION_ERROR');
  });
  it('requireRole rejects officers and unauthenticated callers', async () => {
    const officer = await loginToken('synthetic.officer');
    await expectError(await call('/api/test/admin-only', { cookie: officer }), 403, 'AUTHORIZATION_ERROR');
    await expectError(await call('/api/test/admin-only'), 401, 'AUTHENTICATION_ERROR');
  });
});

describe('single-device policy and session fixation', () => {
  it('rejects a second OFFICER device with 409 and keeps the first session valid', async () => {
    const first = await loginToken('synthetic.officer');
    const second = await login('synthetic.officer');
    const error = await expectError(second, 409, 'SESSION_CONFLICT');
    expect(String(error.message)).toContain('admin');
    expect(second.headers.get('set-cookie')).toBeNull();
    expect((await call('/api/auth/me', { cookie: first })).status).toBe(200);
  });
  it('rotates an OFFICER session when re-login presents the own cookie', async () => {
    const first = await loginToken('synthetic.officer');
    const second = await loginToken('synthetic.officer', first);
    expect(second).not.toBe(first);
    await expectError(await call('/api/auth/me', { cookie: first }), 401, 'AUTHENTICATION_ERROR');
    expect((await call('/api/auth/me', { cookie: second })).status).toBe(200);
  });
  it('allows ADMIN multi-device sessions', async () => {
    const tokens = [await loginToken('synthetic.admin'), await loginToken('synthetic.admin'), await loginToken('synthetic.admin')];
    for (const token of tokens) expect((await call('/api/auth/me', { cookie: token })).status).toBe(200);
  });
  it('never adopts an attacker-planted or unknown cookie token', async () => {
    const planted = generateSessionToken();
    const issued = await loginToken('synthetic.officer', planted);
    expect(issued).not.toBe(planted);
    expect(await db.prepare('SELECT count(*) AS n FROM user_sessions WHERE token_hash=?').bind(await hashSessionToken(planted)).first('n')).toBe(0);
    await expectError(await call('/api/auth/me', { cookie: planted }), 401, 'AUTHENTICATION_ERROR');
    expect((await login('synthetic.admin', PASSWORD, 'malformed;value')).status).toBe(200);
  });
  it('revokes another user session named by the request cookie and rolls it back on conflict', async () => {
    const admin = await loginToken('synthetic.admin');
    const other = await loginToken('synthetic.other', admin);
    await expectError(await call('/api/auth/me', { cookie: admin }), 401, 'AUTHENTICATION_ERROR');
    expect((await call('/api/auth/me', { cookie: other })).status).toBe(200);
    // Batch atomicity: a conflicting officer login must not revoke the cookie session it carried.
    const admin2 = await loginToken('synthetic.admin');
    await loginToken('synthetic.officer');
    await expectError(await login('synthetic.officer', PASSWORD, admin2), 409, 'SESSION_CONFLICT');
    expect((await call('/api/auth/me', { cookie: admin2 })).status).toBe(200);
  });
  it('maps the D1 Inactive session user trigger (deactivated mid-login) to 401', async () => {
    const real = db as unknown as D1Database;
    dbOverride = Object.assign(Object.create(null), {
      prepare: (query: string) => real.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => { await sql('UPDATE users SET is_active=0 WHERE id=?', ID.admin); return real.batch(statements); },
    }) as D1Database;
    await expectError(await login('synthetic.admin'), 401, 'INVALID_CREDENTIALS');
    await expect(sql('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+60)', 'x', ID.admin, 'a'.repeat(64))).rejects.toThrow('Inactive session user');
  });
});

describe('CSRF and body limit', () => {
  it.each([
    ['foreign Origin', { Origin: 'https://evil.test' }], ['Origin null', { Origin: 'null' }],
    ['Origin with different scheme', { Origin: 'http://app.test' }], ['missing Origin without fetch metadata', { Origin: '' }],
    ['missing Origin cross-site fetch metadata', { Origin: '', 'Sec-Fetch-Site': 'cross-site' }],
    ['matching Origin but same-site fetch metadata', { 'Sec-Fetch-Site': 'same-site' }],
    ['text/plain', { 'Content-Type': 'text/plain' }], ['form encoding', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['missing content type', { 'Content-Type': '' }], ['non-UTF-8 charset', { 'Content-Type': 'application/json; charset=latin1' }],
    ['JSON-like subtype', { 'Content-Type': 'application/json-patch+json' }],
  ])('rejects login with %s', async (_name, headers) => {
    const response = await login('synthetic.officer', PASSWORD, undefined, headers);
    await expectError(response, 403, 'CSRF_REJECTED');
    expect(await db.prepare('SELECT count(*) AS n FROM user_sessions').first('n')).toBe(0);
  });
  it.each([
    ['same-origin fetch metadata without Origin', { Origin: '', 'Sec-Fetch-Site': 'same-origin' }],
    ['case-insensitive media type with charset', { 'Content-Type': 'Application/JSON; Charset=UTF-8' }],
    ['matching Origin with same-origin fetch metadata', { 'Sec-Fetch-Site': 'same-origin' }],
  ])('accepts login with %s', async (_name, headers) => {
    expect((await login('synthetic.admin', PASSWORD, undefined, headers)).status).toBe(200);
  });
  it('protects logout and raid writes; GET is not subject to CSRF', async () => {
    const token = await loginToken('synthetic.officer');
    await expectError(await call('/api/auth/logout', { body: {}, cookie: token, headers: { Origin: 'https://evil.test' } }), 403, 'CSRF_REJECTED');
    await expectError(await call('/api/raid-sessions', { body: { location_id: ID.location, lane: 'A' }, cookie: token, headers: { Origin: 'null' } }), 403, 'CSRF_REJECTED');
    expect((await call('/api/auth/me', { cookie: token })).status).toBe(200);
    expect((await call('/api/auth/me', { cookie: token, headers: { Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200);
  });
  it('rejects bodies above 4 KiB with 413', async () => {
    const big = JSON.stringify({ username: 'synthetic.officer', password: PASSWORD, padding: 'x'.repeat(5000) });
    await expectError(await call('/api/auth/login', { body: big }), 413, 'PAYLOAD_TOO_LARGE');
    const streamed = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } });
    const response = await app.request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: streamed, duplex: 'half' } as RequestInit, env());
    await expectError(response, 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('locations and raid sessions', () => {
  it('lists only active locations for authenticated users', async () => {
    await expectError(await call('/api/locations'), 401, 'AUTHENTICATION_ERROR');
    const response = await call('/api/locations', { cookie: await loginToken('synthetic.officer') });
    expect(await response.json()).toEqual({ locations: [{ id: ID.location, name: 'Pos Synthetic Oebobo' }] });
  });
  it('lets an officer create, read, close idempotently and reopen an owned raid', async () => {
    const token = await loginToken('synthetic.officer');
    const created = await createRaid(token, ID.location, '  Jalur Utara A  ');
    expect(created.status).toBe(201);
    const raid = await created.json() as { id: string; started_at: number; closed_at: null; status: string; lane: string; location: unknown };
    expect(raid).toMatchObject({ location: { id: ID.location, name: 'Pos Synthetic Oebobo' }, lane: 'Jalur Utara A', status: 'ACTIVE', closed_at: null });
    expect(Number.isInteger(raid.started_at)).toBe(true);
    expect(Object.keys(raid).sort()).toEqual(['closed_at', 'id', 'lane', 'location', 'started_at', 'status']);
    expect(await db.prepare('SELECT user_id FROM raid_sessions WHERE id=?').bind(raid.id).first('user_id')).toBe(ID.officer);
    expect(await (await call('/api/raid-sessions/active', { cookie: token })).json()).toEqual({ active_raid_session: raid });
    expect((await (await call('/api/auth/me', { cookie: token })).json() as { active_raid_session: unknown }).active_raid_session).toEqual(raid);
    await expectError(await createRaid(token), 409, 'RAID_SESSION_ALREADY_ACTIVE');

    const closed = await call(`/api/raid-sessions/${raid.id}/close`, { body: {}, cookie: token });
    expect(closed.status).toBe(200);
    const closedBody = await closed.json() as { status: string; closed_at: number };
    expect(closedBody).toMatchObject({ id: raid.id, status: 'CLOSED' });
    expect(closedBody.closed_at).toBeGreaterThanOrEqual(raid.started_at);
    const again = await call(`/api/raid-sessions/${raid.id}/close`, { body: {}, cookie: token });
    expect(await again.json()).toEqual(closedBody);
    expect(await (await call('/api/raid-sessions/active', { cookie: token })).json()).toEqual({ active_raid_session: null });
    expect((await createRaid(token, ID.location, 'Jalur 2')).status).toBe(201);
  });
  it('lets an admin create an owned raid and keeps raids per user', async () => {
    const admin = await loginToken('synthetic.admin');
    const officer = await loginToken('synthetic.officer');
    const created = await createRaid(admin);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect(await db.prepare('SELECT user_id FROM raid_sessions WHERE id=?').bind(id).first('user_id')).toBe(ID.admin);
    expect(await (await call('/api/raid-sessions/active', { cookie: officer })).json()).toEqual({ active_raid_session: null });
    expect((await createRaid(officer)).status).toBe(201);
    // Close is owner-only: another user's raid is indistinguishable from a missing one.
    await expectError(await call(`/api/raid-sessions/${id}/close`, { body: {}, cookie: officer }), 404, 'RAID_SESSION_NOT_FOUND');
    await expectError(await call(`/api/raid-sessions/${ID.missingLocation}/close`, { body: {}, cookie: officer }), 404, 'RAID_SESSION_NOT_FOUND');
    await expectError(await call('/api/raid-sessions/not-a-uuid/close', { body: {}, cookie: officer }), 404, 'RAID_SESSION_NOT_FOUND');
    expect(await db.prepare('SELECT status FROM raid_sessions WHERE id=?').bind(id).first('status')).toBe('ACTIVE');
  });
  it('requires authentication for raid routes', async () => {
    await expectError(await call('/api/raid-sessions/active'), 401, 'AUTHENTICATION_ERROR');
    await expectError(await call('/api/raid-sessions', { body: { location_id: ID.location, lane: 'A' } }), 401, 'AUTHENTICATION_ERROR');
    await expectError(await call(`/api/raid-sessions/${ID.location}/close`, { body: {} }), 401, 'AUTHENTICATION_ERROR');
  });
  it('rejects missing, inactive and non-UUID locations with 422', async () => {
    const token = await loginToken('synthetic.officer');
    for (const location of [ID.missingLocation, ID.closedLocation, 'unknown-location']) await expectError(await createRaid(token, location), 422, 'LOCATION_UNAVAILABLE');
    await expectError(await createRaid(token, 42), 400, 'INVALID_INPUT');
    expect(await db.prepare('SELECT count(*) AS n FROM raid_sessions').first('n')).toBe(0);
  });
  it.each([
    ['empty', ''], ['whitespace', '   '], ['NUL', 'Jalur\u0000A'], ['newline', 'Jalur\nA'], ['DEL', 'Jalur\u007f'],
    ['bidi override', '\u202EJalur'], ['bidi isolate', 'Jalur\u2066A'], ['101 code points', 'x'.repeat(101)],
    ['lone surrogate', 'Jalur\ud800'], ['number', 1], ['null', null],
  ])('rejects lane: %s', async (_name, lane) => {
    await expectError(await createRaid(await loginToken('synthetic.officer'), ID.location, lane), 400, 'INVALID_INPUT');
  });
  it('rejects a missing lane, malformed JSON and non-object raid bodies', async () => {
    const token = await loginToken('synthetic.officer');
    for (const body of [{ location_id: ID.location }, '{"location_id":', '[]', 'null']) await expectError(await call('/api/raid-sessions', { body, cookie: token }), 400, 'INVALID_INPUT');
  });
  it.each([['Jalur Utara A'], ['Lajur 2 \u2014 Arah Kupang'], ['\u{1F693}'.repeat(100)], ['Jalur \u00e9\u00e8 \u4e2d']])('accepts free-form lane %s', async lane => {
    const response = await createRaid(await loginToken('synthetic.officer'), ID.location, lane);
    expect(response.status).toBe(201);
    expect((await response.json() as { lane: string }).lane).toBe(lane);
  });
  it('blocks a user deactivated before the create batch and retains the D1 trigger backstop', async () => {
    const token = await loginToken('synthetic.officer');
    const real = db as unknown as D1Database;
    dbOverride = Object.assign(Object.create(null), {
      prepare: (query: string) => real.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        await sql('UPDATE users SET is_active=0 WHERE id=?', ID.officer);
        return real.batch(statements);
      },
    }) as D1Database;
    const response = await createRaid(token);
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toBe(CLEARED);
    await expect(sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('r',?,?,'A')", ID.officer, ID.location)).rejects.toThrow('Inactive raid location or user');
  });
  it('relies on the exact D1 unique-index message for duplicate active raids', async () => {
    await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('r1',?,?,'A')", ID.other, ID.location);
    await expect(sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('r2',?,?,'B')", ID.other, ID.location)).rejects.toThrow('UNIQUE constraint failed: raid_sessions.user_id');
  });
});

// Intercept the boundary after requireAuth, but execute every mutation/result query in actual D1.
// Advancing only SQL's guard clock is deterministic and leaves the immutable expiry schema intact.
function interceptRaidBatch(before: () => Promise<void>, options: { futureClock?: boolean; after?: () => Promise<void> } = {}): void {
  const real = db as unknown as D1Database;
  let intercepted = false;
  dbOverride = {
    prepare: (query: string) => real.prepare(options.futureClock && query.includes('s.id = ? AND s.user_id = ?')
      ? query.replaceAll('s.expires_at > unixepoch()', `s.expires_at > (unixepoch() + ${TTL + 1})`) : query),
    batch: async (statements: D1PreparedStatement[]) => {
      expect(intercepted).toBe(false);
      intercepted = true;
      await before();
      const results = await real.batch(statements);
      await options.after?.();
      return results;
    },
  } as D1Database;
}
async function revokeToken(token: string): Promise<void> {
  await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE token_hash=? AND revoked_at IS NULL', await hashSessionToken(token));
}

describe('atomic raid mutation authorization regressions', () => {
  it.each(['revoked', 'expired', 'deactivated'] as const)('blocks create when the authenticated session becomes %s after requireAuth', async reason => {
    const token = await loginToken('synthetic.officer');
    interceptRaidBatch(async () => {
      if (reason === 'revoked') await revokeToken(token);
      if (reason === 'deactivated') await sql('UPDATE users SET is_active=0 WHERE id=?', ID.officer);
    }, { futureClock: reason === 'expired' });
    const response = await createRaid(token);
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toBe(CLEARED);
    expect(await db.prepare('SELECT count(*) AS n FROM raid_sessions').first('n')).toBe(0);
  });
  it.each(['revoked', 'expired', 'deactivated'] as const)('blocks close when the authenticated session becomes %s after requireAuth', async reason => {
    const token = await loginToken('synthetic.officer');
    const { id } = await (await createRaid(token)).json() as { id: string };
    interceptRaidBatch(async () => {
      if (reason === 'revoked') await revokeToken(token);
      if (reason === 'deactivated') await sql('UPDATE users SET is_active=0 WHERE id=?', ID.officer);
    }, { futureClock: reason === 'expired' });
    const response = await call(`/api/raid-sessions/${id}/close`, { body: {}, cookie: token });
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toBe(CLEARED);
    expect(await db.prepare('SELECT status,closed_at FROM raid_sessions WHERE id=?').bind(id).first()).toMatchObject({ status: 'ACTIVE', closed_at: null });
  });
  it.each(['closed', 'non-owner', 'missing', 'malformed'] as const)('returns 401 for a revoked session even for %s close target', async target => {
    const token = await loginToken('synthetic.officer');
    let id = ID.missingLocation as string;
    if (target === 'closed' || target === 'non-owner') {
      id = crypto.randomUUID();
      await sql('INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES(?,?,?,?)', id, target === 'closed' ? ID.officer : ID.other, ID.location, 'A');
      if (target === 'closed') await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id=?", id);
    }
    if (target === 'malformed') id = 'malformed';
    interceptRaidBatch(() => revokeToken(token));
    const response = await call(`/api/raid-sessions/${id}/close`, { body: {}, cookie: token });
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toBe(CLEARED);
  });
  it.each(['missing location', 'duplicate active'] as const)('prioritizes invalid session over %s on create', async target => {
    const token = await loginToken('synthetic.officer');
    if (target === 'duplicate active') await createRaid(token);
    interceptRaidBatch(() => revokeToken(token));
    await expectError(await createRaid(token, target === 'missing location' ? ID.missingLocation : ID.location), 401, 'AUTHENTICATION_ERROR');
    expect(await db.prepare('SELECT count(*) AS n FROM raid_sessions').first('n')).toBe(target === 'duplicate active' ? 1 : 0);
  });
  it.each(['create', 'close'] as const)('cannot substitute another live session for the revoked request session on %s', async action => {
    const token = await loginToken('synthetic.admin');
    const sameUser = await loginToken('synthetic.admin');
    const otherUser = await loginToken('synthetic.officer');
    const sameSession = await db.prepare('SELECT id FROM user_sessions WHERE token_hash=?').bind(await hashSessionToken(sameUser)).first<string>('id');
    const otherSession = await db.prepare('SELECT id FROM user_sessions WHERE token_hash=?').bind(await hashSessionToken(otherUser)).first<string>('id');
    let raidId = '';
    if (action === 'close') raidId = (await (await createRaid(token)).json() as { id: string }).id;
    interceptRaidBatch(() => revokeToken(token));
    // Neither arbitrary payload IDs nor another live session of the same ADMIN authorize this cookie.
    const response = await call(action === 'create' ? '/api/raid-sessions' : `/api/raid-sessions/${raidId}/close`, {
      cookie: token, body: { location_id: ID.location, lane: 'A', sessionId: sameSession, session_id: otherSession, user_id: ID.officer },
    });
    await expectError(response, 401, 'AUTHENTICATION_ERROR');
    if (action === 'create') expect(await db.prepare('SELECT count(*) AS n FROM raid_sessions').first('n')).toBe(0);
    else expect(await db.prepare('SELECT status FROM raid_sessions WHERE id=?').bind(raidId).first('status')).toBe('ACTIVE');
    dbOverride = undefined;
    expect((await call('/api/auth/me', { cookie: sameUser })).status).toBe(200);
    expect((await call('/api/auth/me', { cookie: otherUser })).status).toBe(200);
  });
  it.each(['create', 'close'] as const)('does not hide successful %s when revoked after the batch commits', async action => {
    const token = await loginToken('synthetic.officer');
    let raidId = '';
    if (action === 'close') raidId = (await (await createRaid(token)).json() as { id: string }).id;
    interceptRaidBatch(async () => {}, { after: () => revokeToken(token) });
    const response = action === 'create' ? await createRaid(token) : await call(`/api/raid-sessions/${raidId}/close`, { body: {}, cookie: token });
    expect(response.status).toBe(action === 'create' ? 201 : 200);
    const raid = await response.json() as { id: string; status: string };
    expect(raid.status).toBe(action === 'create' ? 'ACTIVE' : 'CLOSED');
    expect(await db.prepare('SELECT status FROM raid_sessions WHERE id=?').bind(raid.id).first('status')).toBe(raid.status);
  });
  it('uses batch auth results rather than a later revocation to classify unavailable location', async () => {
    const token = await loginToken('synthetic.officer');
    interceptRaidBatch(async () => {}, { after: () => revokeToken(token) });
    await expectError(await createRaid(token, ID.missingLocation), 422, 'LOCATION_UNAVAILABLE');
  });
  it.each(['create', 'close'] as const)('permits the current OFFICER role after an ADMIN role change before %s', async action => {
    const token = await loginToken('synthetic.admin');
    let raidId = '';
    if (action === 'close') raidId = (await (await createRaid(token)).json() as { id: string }).id;
    interceptRaidBatch(async () => { await sql("UPDATE users SET role='OFFICER' WHERE id=?", ID.admin); });
    const response = action === 'create' ? await createRaid(token) : await call(`/api/raid-sessions/${raidId}/close`, { body: {}, cookie: token });
    expect(response.status).toBe(action === 'create' ? 201 : 200);
    const { id } = await response.json() as { id: string };
    expect(await db.prepare('SELECT user_id FROM raid_sessions WHERE id=?').bind(id).first('user_id')).toBe(ID.admin);
  });
  it('allows an authenticated owner to close a raid at a deactivated location', async () => {
    const token = await loginToken('synthetic.officer');
    const { id } = await (await createRaid(token)).json() as { id: string };
    interceptRaidBatch(async () => { await sql('UPDATE locations SET is_active=0 WHERE id=?', ID.location); });
    expect((await call(`/api/raid-sessions/${id}/close`, { body: {}, cookie: token })).status).toBe(200);
    expect(await db.prepare('SELECT status FROM raid_sessions WHERE id=?').bind(id).first('status')).toBe('CLOSED');
  });
});

describe('safe logging', () => {
  it('never logs usernames, passwords, tokens or cookies', async () => {
    const spy = vi.spyOn(console, 'log');
    const token = await loginToken('synthetic.officer');
    await login('synthetic.officer', 'Wrong-Pass');
    await call('/api/auth/me', { cookie: 'x'.repeat(43) });
    await call('/api/auth/logout', { body: {}, cookie: token });
    const output = logLines.join('\n') + JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(logLines.map(line => (JSON.parse(line) as { event: string }).event)).toEqual(expect.arrayContaining(['auth_login_succeeded', 'request_failed', 'auth_logout']));
    for (const secret of [PASSWORD, 'Wrong-Pass', token, 'synthetic', 'rs_session', 'x'.repeat(43)]) expect(output).not.toContain(secret);
    for (const line of logLines) expect(Object.keys(JSON.parse(line)).every(key => ['event', 'request_id', 'code'].includes(key))).toBe(true);
  });
});
