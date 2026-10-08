import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, parseHistoryCheckPage, parseHistoryRaidPage, parseRaidSummary } from '../src/lib/api';

const RAID = '22222222-2222-4222-8222-222222222222';
const location = { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic location' };
const owner = { id: '33333333-3333-4333-8333-333333333333', username: 'synthetic.officer' };
const raid = { id: RAID, location, lane: 'east lane', status: 'CLOSED', started_at: 1791331200, closed_at: 1791334800, owner };
const activeRaid = { ...raid, id: '44444444-4444-4444-8444-444444444444', status: 'ACTIVE', closed_at: null };
const found = { id: '55555555-5555-4555-8555-555555555555', nopol: 'DH1234ZZ', outcome: 'FOUND', tax_status: 'EXPIRED', stnk_status: 'ACTIVE', source: 'CACHE', checked_at: 1791331300 };
const notFound = { id: '66666666-6666-4666-8666-666666666666', nopol: 'DH1A', outcome: 'NOT_FOUND', tax_status: null, stnk_status: null, source: 'LIVE', checked_at: 1791331250 };
const summary = { total_checks: 5, found: 4, not_found: 1, tax_active: 2, tax_expired: 1, tax_unknown: 1 };
// Opaque synthetic cursor using the full allowed alphabet; the client never decodes it.
const cursor = 'c3ludGhldGljLWN1cnNvcg_-Az09';
const sensitive = { owner_name: 'SENSITIVE_OWNER', NIK: 'SENSITIVE_NIK', alamat: 'SENSITIVE_ADDRESS', raw: { NoRangka: 'SENSITIVE_CHASSIS' } };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const invalidResponse = expect.objectContaining({ code: 'INVALID_RESPONSE' });

describe('history parsers', () => {
  it('accepts actual contract bodies for raid list, checks and summary', () => {
    expect(parseHistoryRaidPage({ raid_sessions: [activeRaid, raid], next_cursor: cursor })).toEqual({ raid_sessions: [activeRaid, raid], next_cursor: cursor });
    expect(parseHistoryRaidPage({ raid_sessions: [], next_cursor: null })).toEqual({ raid_sessions: [], next_cursor: null });
    expect(parseHistoryCheckPage({ checks: [found, notFound], next_cursor: null })).toEqual({ checks: [found, notFound], next_cursor: null });
    expect(parseRaidSummary({ raid_session: raid, summary }, RAID)).toEqual({ raid_session: raid, summary });
    const zeros = { total_checks: 0, found: 0, not_found: 0, tax_active: 0, tax_expired: 0, tax_unknown: 0 };
    expect(parseRaidSummary({ raid_session: raid, summary: zeros }, RAID).summary).toEqual(zeros);
  });
  it('accepts maximum Date-safe epochs and a 64-character opaque cursor without decoding', () => {
    const maximum = 8640000000000;
    const boundedCursor = 'Az09_-'.repeat(10) + 'Az09';
    expect(boundedCursor).toHaveLength(64);
    expect(parseHistoryRaidPage({ raid_sessions: [{ ...raid, started_at: maximum, closed_at: maximum }], next_cursor: boundedCursor }).raid_sessions[0]!.started_at).toBe(maximum);
    expect(parseHistoryCheckPage({ checks: [{ ...found, checked_at: maximum }], next_cursor: boundedCursor }).checks[0]!.checked_at).toBe(maximum);
    expect(new Date(maximum * 1000).toISOString()).toBe('+275760-09-13T00:00:00.000Z');
  });
  it.each([8640000000001, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN])('rejects out-of-range history epochs (%s)', timestamp => {
    expect(() => parseHistoryRaidPage({ raid_sessions: [{ ...activeRaid, started_at: timestamp }], next_cursor: null })).toThrow(invalidResponse);
    expect(() => parseHistoryRaidPage({ raid_sessions: [{ ...raid, closed_at: timestamp }], next_cursor: null })).toThrow(invalidResponse);
    expect(() => parseHistoryCheckPage({ checks: [{ ...found, checked_at: timestamp }], next_cursor: null })).toThrow(invalidResponse);
  });
  it.each(['a%2Fb', 'abc\n', 'é', 'a'.repeat(65)])('rejects encoded, non-ASCII and overbound response cursors (%s)', next_cursor => {
    expect(() => parseHistoryRaidPage({ raid_sessions: [], next_cursor })).toThrow(invalidResponse);
    expect(() => parseHistoryCheckPage({ checks: [], next_cursor })).toThrow(invalidResponse);
  });
  it('projects only contract fields and drops extra or sensitive fields', () => {
    const list = parseHistoryRaidPage({ raid_sessions: [{ ...raid, ...sensitive, user_id: 'x', owner: { ...owner, password_hash: 'SENSITIVE_HASH' }, location: { ...location, ...sensitive } }], next_cursor: null, request_id: 'r', ...sensitive });
    expect(list).toEqual({ raid_sessions: [raid], next_cursor: null });
    const checks = parseHistoryCheckPage({ checks: [{ ...found, ...sensitive, idempotency_key: 'k', user_id: 'u' }, { ...notFound, ...sensitive }], next_cursor: null, ...sensitive });
    expect(checks).toEqual({ checks: [found, notFound], next_cursor: null });
    const recap = parseRaidSummary({ raid_session: { ...raid, ...sensitive }, summary: { ...summary, ...sensitive, stnk_active: 9 }, ...sensitive }, RAID);
    expect(recap).toEqual({ raid_session: raid, summary });
    expect(JSON.stringify([list, checks, recap])).not.toMatch(/SENSITIVE|owner_name|NIK|alamat|raw|idempotency|password/);
  });
  it.each([
    ['null', null], ['array', []], ['missing list', { next_cursor: null }], ['list not array', { raid_sessions: {}, next_cursor: null }],
    ['missing cursor', { raid_sessions: [] }], ['cursor empty', { raid_sessions: [], next_cursor: '' }], ['cursor too long', { raid_sessions: [], next_cursor: 'a'.repeat(65) }],
    ['cursor padding', { raid_sessions: [], next_cursor: 'abc=' }], ['cursor slash', { raid_sessions: [], next_cursor: 'a/b' }], ['cursor number', { raid_sessions: [], next_cursor: 1 }],
    ['raid status', { raid_sessions: [{ ...raid, status: 'OPEN' }], next_cursor: null }], ['active closed_at', { raid_sessions: [{ ...activeRaid, closed_at: 1791334800 }], next_cursor: null }],
    ['closed without closed_at', { raid_sessions: [{ ...raid, closed_at: null }], next_cursor: null }], ['started float', { raid_sessions: [{ ...raid, started_at: 1.5 }], next_cursor: null }],
    ['started negative', { raid_sessions: [{ ...raid, started_at: -1 }], next_cursor: null }], ['started string', { raid_sessions: [{ ...raid, started_at: '1791331200' }], next_cursor: null }],
    ['owner missing', { raid_sessions: [{ ...raid, owner: undefined }], next_cursor: null }], ['owner id', { raid_sessions: [{ ...raid, owner: { ...owner, id: 'bad' } }], next_cursor: null }],
    ['owner username', { raid_sessions: [{ ...raid, owner: { ...owner, username: 'Bad Name' } }], next_cursor: null }], ['location', { raid_sessions: [{ ...raid, location: { id: location.id } }], next_cursor: null }],
    ['null item', { raid_sessions: [null], next_cursor: null }],
  ])('rejects malformed raid list as INVALID_RESPONSE (%s)', (_name, value) => {
    expect(() => parseHistoryRaidPage(value)).toThrow(invalidResponse);
    expect(() => parseHistoryRaidPage(value)).toThrow(ApiError);
  });
  it.each([
    ['missing checks', { next_cursor: null }], ['bad cursor', { checks: [], next_cursor: 'bad cursor' }],
    ['outcome enum', { checks: [{ ...found, outcome: 'MAYBE' }], next_cursor: null }], ['tax enum', { checks: [{ ...found, tax_status: 'MATI' }], next_cursor: null }],
    ['stnk enum', { checks: [{ ...found, stnk_status: 'active' }], next_cursor: null }], ['FOUND null tax', { checks: [{ ...found, tax_status: null }], next_cursor: null }],
    ['FOUND null stnk', { checks: [{ ...found, stnk_status: null }], next_cursor: null }], ['source enum', { checks: [{ ...found, source: 'BPAD' }], next_cursor: null }],
    ['NOT_FOUND tax non-null', { checks: [{ ...notFound, tax_status: 'ACTIVE' }], next_cursor: null }], ['NOT_FOUND stnk non-null', { checks: [{ ...notFound, stnk_status: 'UNKNOWN' }], next_cursor: null }],
    ['NOT_FOUND cache', { checks: [{ ...notFound, source: 'CACHE' }], next_cursor: null }], ['NOT_FOUND missing status', { checks: [{ ...notFound, tax_status: undefined }], next_cursor: null }],
    ['nopol lowercase', { checks: [{ ...found, nopol: 'dh1234zz' }], next_cursor: null }], ['nopol spaces', { checks: [{ ...found, nopol: 'DH 1234 ZZ' }], next_cursor: null }],
    ['nopol punctuation', { checks: [{ ...found, nopol: 'DH-1234' }], next_cursor: null }], ['checked_at float', { checks: [{ ...found, checked_at: 1.25 }], next_cursor: null }],
    ['checked_at negative', { checks: [{ ...found, checked_at: -5 }], next_cursor: null }], ['id', { checks: [{ ...found, id: 'not-a-uuid' }], next_cursor: null }],
  ])('rejects malformed checks as INVALID_RESPONSE (%s)', (_name, value) => {
    expect(() => parseHistoryCheckPage(value)).toThrow(invalidResponse);
  });
  it.each([
    ['missing summary', { raid_session: raid }], ['missing raid', { summary }], ['other raid', { raid_session: activeRaid, summary }],
    ['negative', { raid_session: raid, summary: { ...summary, tax_active: -1, tax_unknown: 2 } }], ['float', { raid_session: raid, summary: { ...summary, total_checks: 5.5 } }],
    ['string', { raid_session: raid, summary: { ...summary, found: '4' } }], ['missing metric', { raid_session: raid, summary: { ...summary, tax_unknown: undefined } }],
    ['total invariant', { raid_session: raid, summary: { ...summary, total_checks: 6 } }], ['found invariant', { raid_session: raid, summary: { ...summary, tax_unknown: 0 } }],
  ])('rejects malformed summary as INVALID_RESPONSE (%s)', (_name, value) => {
    expect(() => parseRaidSummary(value, RAID)).toThrow(invalidResponse);
  });
});

describe('history requests', () => {
  function stub(response: () => Response = () => json({ raid_sessions: [], next_cursor: null })) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }
  it('builds list URLs with default limit and verbatim opaque cursor', async () => {
    const fetcher = stub();
    await api.historyRaids();
    await api.historyRaids(cursor);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/history/raid-sessions', `/api/history/raid-sessions?cursor=${cursor}`]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.method).toBe('GET'); expect(options?.credentials).toBe('same-origin'); expect(options?.cache).toBe('no-store');
      expect(options?.body).toBeUndefined(); expect(options?.headers).toBeUndefined();
    }
  });
  it('builds checks URLs with limit/cursor and encodes the raid ID', async () => {
    const fetcher = stub(() => json({ checks: [], next_cursor: null }));
    await api.raidChecks(RAID);
    await api.raidChecks(RAID, { limit: 10 });
    await api.raidChecks(RAID, { limit: 50, cursor });
    await api.raidChecks('a/b?c#d', { limit: 1 });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      `/api/raid-sessions/${RAID}/checks`, `/api/raid-sessions/${RAID}/checks?limit=10`,
      `/api/raid-sessions/${RAID}/checks?limit=50&cursor=${cursor}`, '/api/raid-sessions/a%2Fb%3Fc%23d/checks?limit=1',
    ]);
    for (const [, options] of fetcher.mock.calls) { expect(options?.credentials).toBe('same-origin'); expect(options?.cache).toBe('no-store'); }
  });
  it('requests summary without any query parameter', async () => {
    const fetcher = stub(() => json({ raid_session: raid, summary }));
    await expect(api.raidSummary(RAID)).resolves.toEqual({ raid_session: raid, summary });
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/raid-sessions/${RAID}/summary`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });
  it.each([[{ limit: 0 }], [{ limit: 51 }], [{ limit: 1.5 }], [{ cursor: '' }], [{ cursor: 'a b' }], [{ cursor: 'x'.repeat(65) }]])('rejects invalid client page params without a request %#', async page => {
    const fetcher = stub();
    await expect(api.raidChecks(RAID, page)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(api.historyRaids('bad/cursor')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [400, 'INVALID_INPUT'], [401, 'AUTHENTICATION_ERROR'], [403, 'AUTHORIZATION_ERROR'], [404, 'RAID_SESSION_NOT_FOUND'], [500, 'INTERNAL_ERROR'],
  ] as const)('preserves error envelope %i %s with request ID', async (status, code) => {
    stub(() => json({ error: { code, message: 'Pesan sintetis', request_id: 'req-history' } }, status, { 'X-Request-ID': 'req-history' }));
    await expect(api.historyRaids()).rejects.toMatchObject({ status, code, message: 'Pesan sintetis', requestId: 'req-history' });
    await expect(api.raidChecks(RAID)).rejects.toMatchObject({ status, code, requestId: 'req-history' });
    await expect(api.raidSummary(RAID)).rejects.toMatchObject({ status, code, requestId: 'req-history' });
  });
  it('keeps the header request ID for invalid success bodies', async () => {
    stub(() => json({ checks: [{ ...notFound, tax_status: 'ACTIVE' }], next_cursor: null }, 200, { 'X-Request-ID': 'req-invalid' }));
    await expect(api.raidChecks(RAID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', requestId: 'req-invalid' });
  });
  it('propagates external cancellation as AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))))));
    const controller = new AbortController();
    const result = expect(api.raidSummary(RAID, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await result;
  });
});
