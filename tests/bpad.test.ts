import { afterEach, describe, expect, it, vi } from 'vitest';
import { BpadPublicApiSource, BPAD_ENDPOINT, BPAD_MAX_BYTES } from '../worker/vehicle/bpad';
import { MockVehicleSource } from '../worker/vehicle/mock';
import { dueStatus } from '../shared/dates';
import type { Fetcher } from '../worker/vehicle/contracts';

const now = () => new Date('2026-10-07T00:00:00Z');
const fixture = { kode: '1', status: 'success', NOPOL: 'DH1234ZZ', NamaPemilik: 'Synthetic Owner', Merk: 'Synthetic Brand', Type: 'Synthetic Type', Warna: 'Synthetic Color', SD_NOTICE: '07/10/2026', SD_STNK: '2027-10-07', address: 'Synthetic forbidden field', chassis: 'Synthetic forbidden field' };
const source = (value: unknown) => new BpadPublicApiSource(async () => Response.json(value), now);
afterEach(() => vi.useRealTimers());
describe('BPAD normalized contract', () => {
  it('POSTs fixed endpoint with body only, manual redirect, no retry and allowlist projection', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json(fixture));
    const result = await new BpadPublicApiSource(fetcher, now).lookup(' dh 1234 zz ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(BPAD_ENDPOINT);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"nopol":"DH1234ZZ"}', redirect: 'manual', headers: { 'content-type': 'application/json' } });
    expect(result).toEqual({ outcome: 'FOUND', vehicle: { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2027-10-07', provider_fetched_at: '2026-10-07T00:00:00.000Z', source: 'LIVE' } });
    expect(JSON.stringify(result)).not.toContain('forbidden');
  });
  it('verified failed metadata produces generic absence without raw pesan', async () => {
    expect(await source({ kode: '0', status: 'failed', pesan: 'Synthetic raw NOPOL data' }).lookup('DH1234ZZ')).toEqual({ outcome: 'NOT_FOUND' });
  });
  it('missing/invalid dates normalize to null and UNKNOWN', async () => {
    const result = await source({ ...fixture, SD_NOTICE: '2026-02-29', SD_STNK: undefined }).lookup('DH1234ZZ');
    expect(result.outcome).toBe('FOUND');
    if (result.outcome === 'FOUND') { expect(result.vehicle.tax_due_date).toBeNull(); expect(result.vehicle.stnk_due_date).toBeNull(); expect(dueStatus(result.vehicle.tax_due_date, now())).toBe('UNKNOWN'); }
  });
  it.each([null, [], [fixture], { data: fixture }, 'invalid', {}, { ...fixture, kode: 1 }, { ...fixture, status: 'failed' }, { ...fixture, kode: '0' }, { kode: '0', status: 'success' }, { kode: '0', status: 'failed', NOPOL: 'DH1234ZZ' }, { ...fixture, NOPOL: 'DH9999ZZ' }, { ...fixture, NOPOL: 'DH-1234ZZ' }, { ...fixture, NOPOL: 1234 }, { ...fixture, NamaPemilik: null }, { ...fixture, Merk: '' }, { ...fixture, Type: {} }, { ...fixture, Warna: '\u0000' }, { ...fixture, NamaPemilik: 'x'.repeat(201) }])('rejects malformed flat payload %j', async value => {
    await expect(source(value).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
  });
  it('rejects input before fetch', async () => {
    const fetcher = vi.fn<Fetcher>();
    await expect(new BpadPublicApiSource(fetcher).lookup({ nopol: 'DH1234ZZ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('BPAD upstream failures', () => {
  it.each([404, 502, 301, 302, 307, 308])('HTTP %i is an error, never absence', async status => {
    await expect(new BpadPublicApiSource(async () => new Response('Synthetic private body', { status, headers: { location: 'https://invalid.example' } })).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
  it('HTTP 504 maps timeout', async () => { await expect(new BpadPublicApiSource(async () => new Response(null, { status: 504 })).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'TIMEOUT' }); });
  it.each([['42', '42'], ['0001', '1'], ['3601', undefined], ['http://evil.example', undefined], ['-1', undefined], ['Wed, 07 Oct 2026 00:00:00 GMT', undefined]])('sanitizes Retry-After %s', async (retry, expected) => {
    await expect(new BpadPublicApiSource(async () => new Response(null, { status: 429, headers: { 'retry-after': retry } })).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_BUSY', retryAfter: expected });
  });
  it('network error is generic and no retry', async () => {
    const fetcher = vi.fn<Fetcher>(async () => { throw new Error('Synthetic secret cookie'); });
    await expect(new BpadPublicApiSource(fetcher).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK', message: 'Layanan data tidak dapat dihubungi.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['not JSON', '<html>secret</html>', '{', 'null'])('rejects nonJSON/invalid body %s', async body => { await expect(new BpadPublicApiSource(async () => new Response(body)).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' }); });
  it('body stream failure maps network', async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('Synthetic private stream error')); } });
    await expect(new BpadPublicApiSource(async () => new Response(stream)).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK' });
  });
  it('oversized content-length rejected even when cancellation never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(new BpadPublicApiSource(async () => new Response(stream, { headers: { 'content-length': String(BPAD_MAX_BYTES + 1) } })).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
    expect(cancel).toHaveBeenCalled();
  });
  it('caps chunked streams even without Content-Length and observes cancellation rejection', async () => {
    const cancel = vi.fn(async () => { throw new Error('Synthetic cancel error'); });
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel });
    await expect(new BpadPublicApiSource(async () => new Response(stream)).lookup('DH1234ZZ')).rejects.toMatchObject({ code: 'UPSTREAM_MALFORMED' });
    expect(cancel).toHaveBeenCalled();
  });
  it('timeout includes headers even if injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const promise = new BpadPublicApiSource(() => new Promise<Response>(() => {})).lookup('DH1234ZZ');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
  it('single total timeout includes delayed headers and never-ending body with nonsettling cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel });
    const fetcher: Fetcher = () => new Promise(resolve => setTimeout(() => resolve(new Response(stream)), 2000));
    const promise = new BpadPublicApiSource(fetcher).lookup('DH1234ZZ');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
});
describe('deterministic synthetic mock', () => {
  it('found fixture is deterministic, result mutation does not persist', async () => {
    const mock = new MockVehicleSource();
    const first = await mock.lookup('dh 1234 zz');
    expect(first).toEqual(await mock.lookup('DH1234ZZ'));
    if (first.outcome === 'FOUND') first.vehicle.owner_name = 'Changed';
    const second = await mock.lookup('DH1234ZZ');
    if (second.outcome === 'FOUND') expect(second.vehicle.owner_name).toBe('Synthetic Owner');
  });
  it('returns deterministic absence and validates input', async () => {
    expect(await new MockVehicleSource().lookup('DH4321ZZ')).toEqual({ outcome: 'NOT_FOUND' });
    await expect(new MockVehicleSource().lookup('DH-1234ZZ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
