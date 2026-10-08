import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, isAcceptablePassword, normalizeUsername, parseAdminUser, parseAdminUsers, parseAdminSession, parseAdminSessions, parseAdminMutation, REQUEST_TIMEOUT_MS } from '../src/lib/api';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = { id: uuid(1), username: 'synthetic.admin', role: 'ADMIN' as const, is_active: true, created_at: 1791331200, updated_at: 1791331201, active_session_count: 2 };
const session = { id: uuid(2), created_at: 1791331200, expires_at: 1791374400, is_current: true };
const extras = { password_hash: 'PRIVATE_HASH', token_hash: 'PRIVATE_TOKEN_HASH', token: 'PRIVATE_TOKEN', raw: { password: 'PRIVATE_PASSWORD' } };
const cursor = 'Opaque_Az09-';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'X-Request-ID': 'req-admin-api' } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('admin allowlist contracts', () => {
  it('projects every DTO and envelope without private extras', () => {
    expect(parseAdminUser({ ...user, ...extras })).toEqual(user);
    expect(parseAdminSession({ ...session, ...extras })).toEqual(session);
    expect(parseAdminUsers({ users: [{ ...user, ...extras }], next_cursor: cursor, ...extras })).toEqual({ users: [user], next_cursor: cursor });
    expect(parseAdminSessions({ sessions: [{ ...session, ...extras }], next_cursor: null, ...extras })).toEqual({ sessions: [session], next_cursor: null });
    expect(parseAdminMutation({ user: { ...user, ...extras }, signed_out: true, ...extras }, user.id)).toEqual({ user, signed_out: true });
    expect(parseAdminUser({ ...user, role: 'OFFICER', is_active: false, active_session_count: 0 })).toMatchObject({ role: 'OFFICER', is_active: false, active_session_count: 0 });
  });
  it.each([null, [], {}, { ...user, id: 'bad' }, { ...user, username: 'Uppercase' }, { ...user, username: 'x'.repeat(101) }, { ...user, role: 'OTHER' }, { ...user, is_active: 1 }, { ...user, created_at: -1 }, { ...user, updated_at: 1 }, { ...user, active_session_count: '1' }, { ...user, active_session_count: 1.1 }, { ...user, active_session_count: -1 }, { ...user, active_session_count: Number.MAX_SAFE_INTEGER + 1 }])('rejects malformed users %#', body => {
    expect(() => parseAdminUser(body)).toThrow(ApiError);
  });
  it.each([null, [], {}, { ...session, id: 'bad' }, { ...session, created_at: '1' }, { ...session, expires_at: session.created_at }, { ...session, expires_at: -1 }, { ...session, is_current: 1 }])('rejects malformed sessions %#', body => {
    expect(() => parseAdminSession(body)).toThrow(ApiError);
  });
  it.each([undefined, '', 'a'.repeat(65), 'cursor=', 'bad+cursor', 1])('rejects invalid or missing cursors %#', next_cursor => {
    expect(() => parseAdminUsers({ users: [], next_cursor })).toThrow(ApiError);
    expect(() => parseAdminSessions({ sessions: [], next_cursor })).toThrow(ApiError);
  });
  it('accepts empty pages and bounds default20/max50 response sizes', () => {
    expect(parseAdminUsers({ users: [], next_cursor: null })).toEqual({ users: [], next_cursor: null });
    expect(parseAdminSessions({ sessions: [], next_cursor: null })).toEqual({ sessions: [], next_cursor: null });
    expect(parseAdminUsers({ users: Array(20).fill(user), next_cursor: cursor }).users).toHaveLength(20);
    expect(parseAdminSessions({ sessions: Array(50).fill(session), next_cursor: cursor }, 50).sessions).toHaveLength(50);
    expect(() => parseAdminUsers({ users: Array(21).fill(user), next_cursor: cursor })).toThrow(ApiError);
    expect(() => parseAdminSessions({ sessions: Array(51).fill(session), next_cursor: cursor }, 50)).toThrow(ApiError);
  });
  it('rejects missing lists, malformed members, mismatched target and nonboolean signed_out', () => {
    for (const body of [{}, { users: null, next_cursor: null }, { users: [null], next_cursor: null }]) expect(() => parseAdminUsers(body)).toThrow(ApiError);
    expect(() => parseAdminSessions({ sessions: [null], next_cursor: null })).toThrow(ApiError);
    expect(() => parseAdminUser(user, uuid(9))).toThrow(ApiError);
    for (const signed_out of [undefined, null, 0, 'false']) expect(() => parseAdminMutation({ user, signed_out }, user.id)).toThrow(ApiError);
    expect(() => parseAdminMutation({ user, signed_out: false }, uuid(9))).toThrow(ApiError);
  });
  it('mirrors username normalization without Unicode aliases', () => {
    expect(normalizeUsername('  Synthetic.New  ')).toBe('synthetic.new');
    for (const value of ['', 'a b', 'K', 'é', 'x'.repeat(101), ' '.repeat(1025)]) expect(normalizeUsername(value)).toBeNull();
  });
  it('matches nonempty <=1024 UTF8 baseline without minimum8 or normalization', () => {
    for (const value of ['x', ' ', 'é'.repeat(512), 'x'.repeat(1024)]) expect(isAcceptablePassword(value)).toBe(true);
    for (const value of ['', 'é'.repeat(513), 'x'.repeat(1025)]) expect(isAcceptablePassword(value)).toBe(false);
  });
});

describe('admin exact requests', () => {
  it('sends exact allowed bodies and paths with same-origin/no-store', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.includes('/sessions/revoke') || path.endsWith('/password')) return json({ user, signed_out: false });
      if (path.includes('/sessions?')) return json({ sessions: [session], next_cursor: null });
      if (init?.method === 'GET' && path.includes('?')) return json({ users: [user], next_cursor: null });
      return json(user, path === '/api/admin/users' ? 201 : 200);
    });
    vi.stubGlobal('fetch', fetcher);
    await api.adminUsers(); await api.adminUsers({ limit: 50, cursor }); await api.adminUser(user.id);
    await api.adminCreate('synthetic.new', ' x ', 'OFFICER'); await api.adminActivate(user.id); await api.adminDeactivate(user.id);
    await api.adminPassword(user.id, ' e\u0301 '); await api.adminSessions(user.id); await api.adminSessions(user.id, { limit: 50, cursor });
    await api.adminRevoke(user.id); await api.adminRevoke(user.id, session.id);
    const base = `/api/admin/users/${user.id}`;
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/admin/users?limit=20', `/api/admin/users?limit=50&cursor=${cursor}`, base, '/api/admin/users', `${base}/activate`, `${base}/deactivate`, `${base}/password`, `${base}/sessions?limit=20`, `${base}/sessions?limit=50&cursor=${cursor}`, `${base}/sessions/revoke`, `${base}/sessions/revoke`]);
    const bodies = [undefined, undefined, undefined, { username: 'synthetic.new', password: ' x ', role: 'OFFICER' }, {}, {}, { password: ' e\u0301 ' }, undefined, undefined, {}, { session_id: session.id }];
    fetcher.mock.calls.forEach(([, init], index) => {
      expect(init?.credentials).toBe('same-origin'); expect(init?.cache).toBe('no-store');
      expect(init?.method).toBe(bodies[index] === undefined ? 'GET' : 'POST');
      expect(init?.body).toBe(bodies[index] === undefined ? undefined : JSON.stringify(bodies[index]));
      expect(init?.headers).toEqual(bodies[index] === undefined ? undefined : { 'Content-Type': 'application/json' });
    });
  });
  it('encodes untrusted path IDs without inventing target DTOs', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { code: 'USER_NOT_FOUND', message: 'Pengguna tidak ditemukan.', request_id: 'req-path' } }, 404));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.adminUser('x/y?#')).rejects.toMatchObject({ status: 404 });
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/users/x%2Fy%3F%23');
  });
  it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: '' }, { cursor: 'a'.repeat(65) }, { cursor: 'a+b' }])('rejects invalid page arguments before fetch %#', async page => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(api.adminUsers(page)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(api.adminSessions(user.id, page)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409])('preserves %i and request ID without a logout fallback', async status => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { code: 'SYNTHETIC_ERROR', message: 'Pesan aman sintetis', request_id: 'req-known', ...extras }, ...extras }, status));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.adminUser(user.id)).rejects.toMatchObject({ status, code: 'SYNTHETIC_ERROR', message: 'Pesan aman sintetis', requestId: 'req-known' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses generic malformed success/error/network messages, never raw payloads', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ...extras }, 200)).mockResolvedValueOnce(json({ error: extras }, 500)).mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT'));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.adminUser(user.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', requestId: 'req-admin-api' });
    await expect(api.adminPassword(user.id, 'x')).rejects.toMatchObject({ code: 'HTTP_ERROR', requestId: 'req-admin-api', message: 'Layanan bermasalah. Coba lagi.' });
    await expect(api.adminCreate('x', 'x', 'ADMIN')).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Tidak dapat terhubung ke layanan. Periksa jaringan dan coba lagi.' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('aborts timeout without replaying a password mutation', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))));
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(api.adminPassword(user.id, 'x')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
