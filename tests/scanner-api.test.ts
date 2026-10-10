import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, formatCalendarDate, formatInstantWita, normalizeNopol, parseVehicleLookup, REQUEST_TIMEOUT_MS } from '../src/lib/api';
// Tests are outside the client graph, so parity can be locked against the backend normalizer.
import { normalizeNopol as serverNormalizeNopol } from '../shared/nopol';

const vehicle = { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: null, tax_status: 'EXPIRED', stnk_status: 'UNKNOWN' };
const found = { outcome: 'FOUND', vehicle, source: 'LIVE', fetched_at: '2026-10-07T01:02:03.004Z', evaluated_on: '2026-10-07', request_id: 'req-synthetic' };
const sensitive = { NIK: 'SENSITIVE_NIK', Alamat: 'SENSITIVE_ADDRESS', NoRangka: 'SENSITIVE_CHASSIS', NoMesin: 'SENSITIVE_ENGINE', NoBPKB: 'SENSITIVE_BPKB', NOPOL_EKS: 'SENSITIVE_EKS', Kohir: 'SENSITIVE_KOHIR' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('vehicle lookup parser', () => {
  it('accepts FOUND and NOT_FOUND contract bodies exactly', () => {
    expect(parseVehicleLookup(found, 'DH1234ZZ')).toEqual(found);
    expect(parseVehicleLookup({ ...found, source: 'CACHE', vehicle: { ...vehicle, stnk_due_date: '2027-01-31', stnk_status: 'ACTIVE' } }, 'DH1234ZZ')).toMatchObject({ source: 'CACHE', vehicle: { stnk_status: 'ACTIVE' } });
    expect(parseVehicleLookup({ outcome: 'NOT_FOUND', request_id: 'req-nf' }, 'DH1234ZZ')).toEqual({ outcome: 'NOT_FOUND', request_id: 'req-nf' });
  });
  it.each(['LIVE', 'CACHE'] as const)('retains %s metadata in the parser and request result despite its removal from scanner UI', async source => {
    const body = { ...found, source };
    expect(parseVehicleLookup(body, 'DH1234ZZ')).toEqual(body);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    vi.stubGlobal('fetch', fetcher);
    const parsed = await api.lookup('DH1234ZZ');
    expect(parsed).toEqual(body);
    expect(parsed).toMatchObject({ source, fetched_at: found.fetched_at, evaluated_on: found.evaluated_on, request_id: found.request_id });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('projects only allowlisted fields and drops sensitive extras', () => {
    const parsed = parseVehicleLookup({ ...found, ...sensitive, raw: sensitive, vehicle: { ...vehicle, ...sensitive } }, 'DH1234ZZ');
    expect(parsed).toEqual(found);
    expect(JSON.stringify(parsed)).not.toContain('SENSITIVE');
    const notFound = parseVehicleLookup({ outcome: 'NOT_FOUND', request_id: 'req-nf', vehicle, message: 'SENSITIVE provider text' }, 'DH1234ZZ');
    expect(notFound).toEqual({ outcome: 'NOT_FOUND', request_id: 'req-nf' });
  });
  it.each([
    ['null', null], ['array', []], ['empty', {}], ['unknown outcome', { ...found, outcome: 'MAYBE' }], ['missing request id', { outcome: 'NOT_FOUND' }],
    ['empty request id', { ...found, request_id: '' }], ['missing vehicle', { ...found, vehicle: undefined }], ['vehicle array', { ...found, vehicle: [] }],
    ['source', { ...found, source: 'BPAD' }], ['fetched_at no ms', { ...found, fetched_at: '2026-10-07T01:02:03Z' }], ['fetched_at offset', { ...found, fetched_at: '2026-10-07T09:02:03.004+08:00' }],
    ['fetched_at invalid calendar', { ...found, fetched_at: '2026-02-30T01:02:03.004Z' }], ['evaluated_on', { ...found, evaluated_on: '07/10/2026' }],
    ['tax_status enum', { ...found, vehicle: { ...vehicle, tax_status: 'MATI' } }], ['stnk_status enum', { ...found, vehicle: { ...vehicle, stnk_status: 'active' } }],
    ['status missing', { ...found, vehicle: { ...vehicle, tax_status: undefined } }], ['due date format', { ...found, vehicle: { ...vehicle, tax_due_date: '07/10/2026' } }],
    ['due date calendar', { ...found, vehicle: { ...vehicle, tax_due_date: '2026-02-29' } }], ['brand null', { ...found, vehicle: { ...vehicle, brand: null } }],
    ['owner empty', { ...found, vehicle: { ...vehicle, owner_name: '' } }], ['color untrimmed', { ...found, vehicle: { ...vehicle, color: ' Merah' } }],
    ['type too long', { ...found, vehicle: { ...vehicle, type: 'x'.repeat(201) } }], ['owner control char', { ...found, vehicle: { ...vehicle, owner_name: 'a\nb' } }],
    ['nopol mismatch', { ...found, vehicle: { ...vehicle, nopol: 'DH9999ZZ' } }], ['nopol lowercase', { ...found, vehicle: { ...vehicle, nopol: 'dh1234zz' } }],
  ])('rejects malformed body as INVALID_RESPONSE, never NOT_FOUND (%s)', (_name, value) => {
    expect(() => parseVehicleLookup(value, 'DH1234ZZ')).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => parseVehicleLookup(value, 'DH1234ZZ')).toThrow(ApiError);
  });
});

describe('client NOPOL normalization parity', () => {
  const server = (value: unknown) => { try { return serverNormalizeNopol(value); } catch { return null; } };
  it.each([
    'DH1234ZZ', 'dh1234zz', 'dh 1234 zz', ' DH 1234 ZZ ', 'DH\t1234\nZZ', 'D1', 'DH1', 'B1A', 'DH-1234', 'DH.1234ZZ', 'DH_1234', '', '   ', '1234', 'DHA1234', 'DH12345', 'DH1234ZZZZ',
    'DH1234ZZZ', 'ĐH1234', 'DH１２３４', 'Dh1234Zz', 'DH\u00a01234', `${' '.repeat(60)}DH1`, `${' '.repeat(61)}DH12`, 'x'.repeat(65), 'DH1234ZZ'.padEnd(64, ' '), 'DH1234ZZ'.padEnd(65, ' '), 'ß1',
  ])('matches shared/nopol.ts for %j', value => {
    expect(normalizeNopol(value)).toBe(server(value));
  });
  it('rejects non-strings like the server', () => {
    for (const value of [null, undefined, 1234, {}, ['DH1']]) { expect(normalizeNopol(value)).toBeNull(); expect(server(value)).toBeNull(); }
  });
  it('keeps documented outcomes', () => {
    expect(normalizeNopol(' dh 1234\tzz ')).toBe('DH1234ZZ');
    expect(normalizeNopol('DH-1234')).toBeNull();
    expect(normalizeNopol('x'.repeat(65))).toBeNull();
  });
});

describe('vehicle lookup requests', () => {
  it('sends exact body, headers, credentials and no-store', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(found));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.lookup('DH1234ZZ')).resolves.toEqual(found);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/vehicle-lookups');
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    expect(options?.body).toBe('{"nopol":"DH1234ZZ"}');
  });
  it('rejects FOUND for a different NOPOL with the response request ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...found, vehicle: { ...vehicle, nopol: 'DH9999ZZ' } }, 200, { 'X-Request-ID': 'req-header' })));
    await expect(api.lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', requestId: 'req-synthetic' });
  });
  it('rejects non-JSON success as INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(api.lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([
    [400, 'INVALID_INPUT'], [401, 'AUTHENTICATION_ERROR'], [403, 'CSRF_REJECTED'], [403, 'AUTHORIZATION_ERROR'], [409, 'RAID_SESSION_REQUIRED'], [413, 'PAYLOAD_TOO_LARGE'],
    [500, 'INTERNAL_ERROR'], [502, 'UPSTREAM_ERROR'], [502, 'UPSTREAM_MALFORMED'], [502, 'UPSTREAM_NETWORK'], [503, 'UPSTREAM_BUSY'], [504, 'TIMEOUT'],
  ] as const)('preserves %i %s error envelope', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code, message: 'Pesan sintetis', request_id: 'req-error' } }, status)));
    await expect(api.lookup('DH1234ZZ')).rejects.toMatchObject({ status, code, message: 'Pesan sintetis', requestId: 'req-error' });
  });
  it('reports network failure generically', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('sensitive detail')));
    await expect(api.lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Tidak dapat terhubung ke layanan. Periksa jaringan dan coba lagi.' });
  });
  it('times out after the shared client timeout and aborts transport', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, options: RequestInit) => {
      signal = options.signal!;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))));
    }));
    const result = expect(api.lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result; expect(signal?.aborted).toBe(true);
  });
  it('propagates caller cancellation as AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))))));
    const controller = new AbortController(); const result = expect(api.lookup('DH1234ZZ', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await result;
  });
});

describe('scanner formatters', () => {
  it('formats due dates from the calendar string without time zone shifts', () => {
    expect(formatCalendarDate('2026-10-07')).toBe('07 Okt 2026');
    expect(formatCalendarDate('2026-01-01')).toBe('01 Jan 2026');
    expect(formatCalendarDate('2024-02-29')).toBe('29 Feb 2024');
    expect(formatCalendarDate('2026-12-31')).toBe('31 Des 2026');
    expect(formatCalendarDate(null)).toBe('Tidak tersedia');
    expect(formatCalendarDate('2026-02-30')).toBe('Tidak tersedia');
  });
  it('does not use Date for calendar dates', () => {
    const spy = vi.spyOn(globalThis, 'Date');
    expect(formatCalendarDate('2026-01-01')).toBe('01 Jan 2026');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('formats fetched_at in WITA across the UTC day boundary', () => {
    const value = formatInstantWita('2026-10-06T16:30:05.000Z');
    expect(value).toMatch(/7/); expect(value).toContain('00.30.05'); expect(value).toContain('WITA');
  });
});
