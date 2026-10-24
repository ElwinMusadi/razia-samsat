import { afterEach, describe, expect, it, vi } from 'vitest';
import { dueStatus } from '../shared/dates';
import type { Fetcher } from '../worker/vehicle/contracts';
import { isPotensiAbsence, mapPotensiPayload, POTENSI_ENDPOINT, POTENSI_MAX_BYTES, POTENSI_TIMEOUT_MS, PotensiSnapshotSource, readPotensiCredentials } from '../worker/vehicle/potensi';

const now = () => new Date('2026-10-20T01:00:00.000Z');
const credentials = { apiKey: 'ptn_Ab12Cd34_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
// Synthetic upstream envelope mirroring api-potensi-ntt shape.ts with the granted scopes only.
const fixture = () => ({
  status: 'vehicle_found', vehicle_status: 'found', njkb_status: 'not_found', nopol: 'DH0001XX',
  vehicle: { category: 'SEPEDA MOTOR', category_raw: 'SEPEDA MOTOR', category_code: null, brand: 'HONDA', brand_code: null, type: 'X1B02N04L0 A/T', type_code: null, year: 2015, color: 'PUTIH-BIRU', fuel: 'PREMIUM', fuel_code: null, engine_capacity_cc: 110, body_modification: null, chassis_number: 'FORBIDDEN_SENTINEL', engine_number: 'FORBIDDEN_SENTINEL', plate_color: 'PUTIH' },
  registration: { bpkb_number: null, previous_nopol: null, stnk_valid_until: '2026-01-06', previous_stnk_date: null, invoice_date: null, plate_color: 'PUTIH', usage: 'PRIBADI', usage_code: null },
  tax: { notice_valid_until: '2024-01-06', previous_pkb_date: null, kohir: null },
  owner: { name: 'PEMILIK CONTOH', identity_number: 'FORBIDDEN_SENTINEL', address: 'FORBIDDEN_SENTINEL', rt: '001', rw: '002', village: 'X', district: 'Y' },
  administrative: { origin_upt: 'Kota Kupang' },
  bpad: { code: '1', status: 'success', message: 'Data ditemukan di salinan potensi BPAD' },
  potensi: { upt_code: '010', district_code: '53.71.05', assessment_date: '2026-10-18', synced_at: '2026-10-18T00:00:00.000Z', compliance: 'Menunggak', warning: 'FORBIDDEN_SENTINEL', amounts: { total: 'FORBIDDEN_SENTINEL' } },
});
const absence = () => ({ status: 'vehicle_not_found', vehicle_status: 'not_found', njkb_status: null, error: { code: 'vehicle_not_found', message: 'Kendaraan tidak ditemukan di data potensi BPAD', request_id: 'req' } });
const source = (fetcher: Fetcher) => new PotensiSnapshotSource(credentials, fetcher, now);
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
afterEach(() => vi.useRealTimers());

describe('Potensi API key presence', () => {
  it('the ptn_ key alone is the credential; leftover Access secrets are ignored; presence is not proof of grant', () => {
    expect(readPotensiCredentials({ POTENSI_API_KEY: credentials.apiKey })).toEqual({ apiKey: credentials.apiKey });
    const access = { POTENSI_ACCESS_CLIENT_ID: 'a.access', POTENSI_ACCESS_CLIENT_SECRET: 'b' };
    expect(readPotensiCredentials({ ...access, POTENSI_API_KEY: credentials.apiKey } as never)).toEqual({ apiKey: credentials.apiKey });
    for (const env of [undefined, {}, access]) expect(readPotensiCredentials(env as never)).toBeNull();
    for (const apiKey of [undefined, '', 1, 'ptn_short', `${credentials.apiKey} `, credentials.apiKey.replace('ptn_', 'pt_'), `ptn_Ab12Cd3_${'A'.repeat(43)}`, `ptn_Ab12Cd34_${'A'.repeat(42)}`, `ptn_Ab12Cd3!_${'A'.repeat(43)}`]) {
      expect(readPotensiCredentials({ ...access, POTENSI_API_KEY: apiKey } as never)).toBeNull();
    }
  });
});

describe('Potensi normalized contract', () => {
  it('GETs the fixed endpoint with only the API key header, manual redirect, no retry and allowlist projection', async () => {
    const fetcher = vi.fn<Fetcher>(async () => json(fixture()));
    const result = await source(fetcher).lookup(' dh 0001 xx ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${POTENSI_ENDPOINT}/DH0001XX`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
    // Exactly these two headers: no Cloudflare Access service token since Access left the host.
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).toEqual({ authorization: `Bearer ${credentials.apiKey}`, accept: 'application/json' });
    expect((fetcher.mock.calls[0][1] as RequestInit).body).toBeUndefined();
    expect(result).toEqual({ outcome: 'FOUND', vehicle: { nopol: 'DH0001XX', owner_name: 'PEMILIK CONTOH', brand: 'HONDA', type: 'X1B02N04L0 A/T', color: 'PUTIH-BIRU', tax_due_date: '2024-01-06', stnk_due_date: '2026-01-06', provider_fetched_at: now().toISOString(), snapshot_synced_at: '2026-10-18T00:00:00.000Z', source: 'LIVE' } });
    expect(JSON.stringify(result)).not.toContain('FORBIDDEN_SENTINEL');
    if (result.outcome === 'FOUND') { expect(dueStatus(result.vehicle.tax_due_date, now())).toBe('EXPIRED'); expect(dueStatus(result.vehicle.stnk_due_date, now())).toBe('EXPIRED'); }
  });
  it('njkb_status not_found is still a FOUND vehicle', async () => {
    const result = await source(async () => json({ ...fixture(), njkb_status: 'not_found', njkb: { value: null } })).lookup('DH0001XX');
    expect(result.outcome).toBe('FOUND');
  });
  it('explicit null identity and dates are legitimate snapshot gaps', async () => {
    const payload = fixture();
    payload.owner.name = null as never; payload.vehicle.brand = null as never; payload.vehicle.type = null as never; payload.vehicle.color = null as never;
    payload.tax.notice_valid_until = null as never; payload.registration.stnk_valid_until = null as never;
    const result = await source(async () => json(payload)).lookup('DH0001XX');
    expect(result).toMatchObject({ outcome: 'FOUND', vehicle: { owner_name: null, brand: null, type: null, color: null, tax_due_date: null, stnk_due_date: null } });
  });
  it('blank identity strings degrade to null and dates are trimmed to the calendar day; unparseable dates become UNKNOWN', async () => {
    const payload = fixture();
    payload.owner.name = '   '; payload.tax.notice_valid_until = '2026-02-30'; payload.registration.stnk_valid_until = '06/01/2026';
    const result = await source(async () => json(payload)).lookup('DH0001XX');
    expect(result).toMatchObject({ outcome: 'FOUND', vehicle: { owner_name: null, tax_due_date: null, stnk_due_date: '2026-01-06' } });
  });
  it.each([
    ['owner block missing (scope)', (p: ReturnType<typeof fixture>) => { delete (p as Record<string, unknown>).owner; }],
    ['registration block missing', (p: ReturnType<typeof fixture>) => { delete (p as Record<string, unknown>).registration; }],
    ['tax block missing', (p: ReturnType<typeof fixture>) => { delete (p as Record<string, unknown>).tax; }],
    ['potensi block missing', (p: ReturnType<typeof fixture>) => { delete (p as Record<string, unknown>).potensi; }],
    ['owner.name key missing', (p: ReturnType<typeof fixture>) => { delete (p.owner as Record<string, unknown>).name; }],
    ['vehicle.brand key missing', (p: ReturnType<typeof fixture>) => { delete (p.vehicle as Record<string, unknown>).brand; }],
    ['vehicle.color wrong type', (p: ReturnType<typeof fixture>) => { (p.vehicle as Record<string, unknown>).color = 7; }],
    ['owner.name control char', (p: ReturnType<typeof fixture>) => { p.owner.name = 'A\u0000B'; }],
    ['owner.name too long', (p: ReturnType<typeof fixture>) => { p.owner.name = 'x'.repeat(201); }],
    ['stnk date wrong type', (p: ReturnType<typeof fixture>) => { (p.registration as Record<string, unknown>).stnk_valid_until = 20260106; }],
    ['status not vehicle_found', (p: ReturnType<typeof fixture>) => { p.status = 'vehicle_not_found'; }],
    ['vehicle_status not found', (p: ReturnType<typeof fixture>) => { p.vehicle_status = 'not_found'; }],
    ['nopol mismatch', (p: ReturnType<typeof fixture>) => { p.nopol = 'DH0002XX'; }],
    ['nopol wrong type', (p: ReturnType<typeof fixture>) => { (p as Record<string, unknown>).nopol = 1; }],
    ['synced_at missing', (p: ReturnType<typeof fixture>) => { delete (p.potensi as Record<string, unknown>).synced_at; }],
    ['synced_at null', (p: ReturnType<typeof fixture>) => { (p.potensi as Record<string, unknown>).synced_at = null; }],
    ['synced_at sqlite format', (p: ReturnType<typeof fixture>) => { p.potensi.synced_at = '2026-10-18 00:00:00'; }],
    ['synced_at offset', (p: ReturnType<typeof fixture>) => { p.potensi.synced_at = '2026-10-18T08:00:00.000+08:00'; }],
    ['synced_at invalid calendar', (p: ReturnType<typeof fixture>) => { p.potensi.synced_at = '2026-02-30T00:00:00.000Z'; }],
    ['synced_at impossible month', (p: ReturnType<typeof fixture>) => { p.potensi.synced_at = '2026-13-01T00:00:00Z'; }],
    ['synced_at impossible hour', (p: ReturnType<typeof fixture>) => { p.potensi.synced_at = '2026-10-18T25:00:00.000Z'; }],
    ['vehicle is array', (p: ReturnType<typeof fixture>) => { (p as Record<string, unknown>).vehicle = []; }],
  ])('rejects %s as UPSTREAM_MALFORMED, never NOT_FOUND', async (_name, mutate) => {
    const payload = fixture(); mutate(payload);
    await expect(source(async () => json(payload)).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
  });
  it.each([null, [], 'invalid', 1, { status: 'vehicle_found' }])('rejects non-object/incomplete payload %j', async value => {
    await expect(source(async () => json(value)).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
    expect(() => mapPotensiPayload(value, 'DH0001XX', now())).toThrow();
  });
  it('accepts synced_at without milliseconds and canonicalizes it', async () => {
    const payload = fixture(); payload.potensi.synced_at = '2026-10-18T00:00:00Z';
    expect(await source(async () => json(payload)).lookup('DH0001XX')).toMatchObject({ vehicle: { snapshot_synced_at: '2026-10-18T00:00:00.000Z' } });
  });
  it('rejects input before fetch and never sends credentials for an invalid plate', async () => {
    const fetcher = vi.fn<Fetcher>();
    await expect(source(fetcher).lookup('DH-0001XX')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Potensi absence versus errors', () => {
  it('HTTP 404 with the documented vehicle_not_found envelope is NOT_FOUND', async () => {
    expect(await source(async () => json(absence(), 404)).lookup('DH9999ZZ')).toEqual({ outcome: 'NOT_FOUND' });
    expect(isPotensiAbsence(absence())).toBe(true);
  });
  it.each([
    ['route 404', json({ status: 'error', error: { code: 'route_not_found', message: 'Route tidak ditemukan', request_id: 'r' } }, 404)],
    ['Access HTML 404', new Response('<html>FORBIDDEN_SENTINEL login</html>', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['404 with vehicle facts', json({ ...absence(), vehicle: { brand: 'X' }, status: 'vehicle_found' }, 404)],
    ['404 wrong error code', json({ ...absence(), error: { code: 'invalid_nopol' } }, 404)],
    ['404 empty body', new Response(null, { status: 404 })],
    ['404 oversize body', new Response('x'.repeat(POTENSI_MAX_BYTES + 1), { status: 404 })],
  ])('HTTP %s is UPSTREAM_ERROR, never absence', async (_name, response) => {
    await expect(source(async () => response).lookup('DH9999ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('isPotensiAbsence requires the full envelope', () => {
    for (const value of [null, {}, { status: 'vehicle_not_found' }, { status: 'vehicle_not_found', vehicle_status: 'not_found' }, { ...absence(), vehicle_status: 'found' }, { ...absence(), error: [] }, { ...absence(), error: null }]) expect(isPotensiAbsence(value)).toBe(false);
  });
  it('HTTP 403 region_not_allowed is its own outcome, without leaking upstream text', async () => {
    const fetcher = vi.fn<Fetcher>(async () => json({ status: 'forbidden', error: { code: 'region_not_allowed', message: 'FORBIDDEN_SENTINEL', request_id: 'r' } }, 403));
    await expect(source(fetcher).lookup('DH0001XX')).rejects.toMatchObject({ code: 'VEHICLE_REGION_NOT_ALLOWED', message: expect.not.stringContaining('FORBIDDEN_SENTINEL') });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['Access HTML', new Response('<html>FORBIDDEN_SENTINEL</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
    ['other forbidden code', json({ status: 'forbidden', error: { code: 'forbidden', message: 'x', request_id: 'r' } }, 403)],
    ['region code without forbidden status', json({ status: 'error', error: { code: 'region_not_allowed', message: 'x', request_id: 'r' } }, 403)],
  ])('HTTP 403 %s stays UPSTREAM_FORBIDDEN', async (_name, response) => {
    await expect(source(async () => response).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_FORBIDDEN' });
  });
  it.each([401, 403])('HTTP %i is UPSTREAM_FORBIDDEN (Razia credential/grant), not a Razia session error', async status => {
    const fetcher = vi.fn<Fetcher>(async () => json({ status: 'unauthorized', error: { code: 'unauthorized', message: 'Kredensial tidak valid FORBIDDEN_SENTINEL', request_id: 'r' } }, status));
    await expect(source(fetcher).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_FORBIDDEN', message: expect.not.stringContaining('FORBIDDEN_SENTINEL') });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([['42', '42'], ['0001', '1'], ['3601', undefined], ['http://evil.example', undefined], ['-1', undefined]])('429 maps UPSTREAM_BUSY and sanitizes Retry-After %s without retry', async (retry, expected) => {
    const fetcher = vi.fn<Fetcher>(async () => json({ status: 'rate_limit_exceeded' }, 429, { 'retry-after': retry }));
    await expect(source(fetcher).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_BUSY', retryAfter: expected });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 500, 502, 503, 301, 302, 307, 308])('HTTP %i is UPSTREAM_ERROR and redirects are never followed', async status => {
    const fetcher = vi.fn<Fetcher>(async () => new Response('FORBIDDEN_SENTINEL', { status, headers: { location: 'https://evil.example/collect' } }));
    await expect(source(fetcher).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('HTTP 504 maps TIMEOUT', async () => { await expect(source(async () => new Response(null, { status: 504 })).lookup('DH0001XX')).rejects.toMatchObject({ code: 'TIMEOUT' }); });
  it('network error is generic, carries no credential text and no retry', async () => {
    const fetcher = vi.fn<Fetcher>(async () => { throw new Error(`leak ${credentials.apiKey}`); });
    await expect(source(fetcher).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK', message: 'Layanan data tidak dapat dihubungi.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['not JSON', '<html>FORBIDDEN_SENTINEL</html>', '{', 'null'])('rejects nonJSON/invalid 200 body %s', async body => {
    await expect(source(async () => new Response(body)).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
  });
  it('caps the body and observes nonsettling cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); }, cancel });
    await expect(source(async () => new Response(stream)).lookup('DH0001XX')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
    expect(cancel).toHaveBeenCalled();
  });
  it('one total deadline covers delayed headers and a never-ending body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel });
    const fetcher: Fetcher = () => new Promise(resolve => setTimeout(() => resolve(new Response(stream)), POTENSI_TIMEOUT_MS - 1000));
    const promise = source(fetcher).lookup('DH0001XX');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(POTENSI_TIMEOUT_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
  it('timeout when the injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const promise = source(() => new Promise<Response>(() => {})).lookup('DH0001XX');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(POTENSI_TIMEOUT_MS);
    await assertion;
  });
});
