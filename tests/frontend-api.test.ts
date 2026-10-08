import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, formatWita, normalizeLane, parseActiveResponse, parseAuth, parseLocations, parseRaid, REQUEST_TIMEOUT_MS } from '../src/lib/api';
const location = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic location' };
const raid = { id: '22222222-2222-4222-8222-222222222222', location, lane: 'east lane', status: 'ACTIVE', started_at: 1791331200, closed_at: null };
const auth = { user: { id: '33333333-3333-4333-8333-333333333333', username: 'synthetic', role: 'ADMIN' }, session: { expires_at: 1791374400 }, active_raid_session: raid };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('client contract validation', () => {
  it('accepts actual auth, locations, active envelope and direct raid bodies', () => {
    expect(parseAuth(auth)).toEqual(auth);
    expect(parseAuth({ ...auth, active_raid_session: null }).active_raid_session).toBeNull();
    expect(parseLocations({ locations: [location] })).toEqual([location]);
    expect(parseActiveResponse({ active_raid_session: raid })).toEqual(raid);
    expect(parseRaid(raid)).toEqual(raid);
    expect(parseRaid({ ...raid, status: 'CLOSED', closed_at: raid.started_at + 1 }).status).toBe('CLOSED');
  });
  it.each([null, [], {}, { ...auth, session: { expires_at: '1791374400' } }, { ...auth, user: { ...auth.user, role: 'OTHER' } }, { ...auth, active_raid_session: { ...raid, status: 'CLOSED', closed_at: 1791331201 } }])('rejects invalid auth %#', value => { expect(() => parseAuth(value)).toThrow(ApiError); });
  it.each([{ raid_session: raid }, { ...raid, started_at: 1.1 }, { ...raid, closed_at: 1791331201 }, { ...raid, status: 'CLOSED', closed_at: null }, { ...raid, status: 'CLOSED', closed_at: 1 }, { ...raid, location: { ...location, id: 'bad' } }])('rejects invalid raid %#', value => { expect(() => parseRaid(value)).toThrow(ApiError); });
  it('does not turn malformed lists or active envelopes into empty data', () => {
    expect(() => parseLocations({ locations: [null] })).toThrow(ApiError);
    expect(() => parseLocations({})).toThrow(ApiError);
    expect(() => parseActiveResponse({ raid_session: raid })).toThrow(ApiError);
  });
  it('uses code points and mirrors free-form lane control/bidi rules', () => {
    expect(normalizeLane(' east lane ')).toBe('east lane');
    expect(normalizeLane('😀'.repeat(100))).toBe('😀'.repeat(100));
    for (const value of ['', 'x'.repeat(101), 'a\nb', 'a\u061cb', 'a\ud800b', 'a\u202eb', 'a\u2066b']) expect(normalizeLane(value)).toBeNull();
  });
  it('renders UTC epoch in Asia/Makassar with WITA', () => {
    const value = formatWita(Date.UTC(2026, 9, 6, 23, 0) / 1000);
    expect(value).toContain('7'); expect(value).toContain('07.00'); expect(value).toContain('WITA');
  });
});
describe('client requests', () => {
  it('sends exact endpoint/body parity including empty JSON logout and close', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async path => {
      if (path === '/api/auth/logout') return new Response(null, { status: 204 });
      if (path === '/api/auth/me' || path === '/api/auth/login') return json(auth);
      if (path === '/api/locations') return json({ locations: [location] });
      if (path === '/api/raid-sessions/active') return json({ active_raid_session: raid });
      if (String(path).endsWith('/close')) return json({ ...raid, status: 'CLOSED', closed_at: raid.started_at + 1 });
      return json(raid, path === '/api/raid-sessions' ? 201 : 200);
    });
    vi.stubGlobal('fetch', fetcher);
    await api.me(); await api.login('synthetic', 'synthetic-password'); await api.locations(); await api.active(); await api.start(location.id, 'east lane'); await api.close(raid.id); await api.logout();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/auth/me', '/api/auth/login', '/api/locations', '/api/raid-sessions/active', '/api/raid-sessions', `/api/raid-sessions/${raid.id}/close`, '/api/auth/logout']);
    const bodies = [undefined, { username: 'synthetic', password: 'synthetic-password' }, undefined, undefined, { location_id: location.id, lane: 'east lane' }, {}, {}];
    fetcher.mock.calls.forEach(([, options], index) => {
      expect(options?.credentials).toBe('same-origin'); expect(options?.cache).toBe('no-store');
      expect(options?.method).toBe(bodies[index] === undefined ? 'GET' : 'POST');
      expect(options?.body).toBe(bodies[index] === undefined ? undefined : JSON.stringify(bodies[index]));
      expect(options?.headers).toEqual(bodies[index] === undefined ? undefined : { 'Content-Type': 'application/json' });
    });
  });
  it('preserves error envelope status, message and request ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'SESSION_CONFLICT', message: 'Pesan sintetis', request_id: 'req-test' } }, 409)));
    await expect(api.login('synthetic', 'synthetic-password')).rejects.toMatchObject({ status: 409, code: 'SESSION_CONFLICT', message: 'Pesan sintetis', requestId: 'req-test' });
  });
  it('falls back safely for malformed error and rejects malformed success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('<html>error</html>', { status: 503, headers: { 'X-Request-ID': 'req-fallback' } })).mockResolvedValueOnce(new Response('invalid')));
    await expect(api.me()).rejects.toMatchObject({ status: 503, requestId: 'req-fallback' });
    await expect(api.me()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reports network failures without leaking raw failure messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive internal detail')));
    await expect(api.me()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Tidak dapat terhubung ke layanan. Periksa jaringan dan coba lagi.' });
  });
  it('bounds slow requests with timeout and aborts transport', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, options: RequestInit) => {
      signal = options.signal!;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))));
    }));
    const result = expect(api.me()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result; expect(signal?.aborted).toBe(true);
  });
  it('propagates external cancellation separately from network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))))));
    const controller = new AbortController(); const result = expect(api.me(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await result;
  });
  it('rejects over-limit JSON before issuing a request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(api.login('synthetic', 'x'.repeat(4096))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
