import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSafeLogger } from '../worker/logger';
import { isFreshVehicle, readVehicleCache, validateCachedVehicle, vehicleCacheKey, writeVehicleCache, type CachedVehicle, type VehicleCacheStore } from '../worker/vehicle/cache';

const NOW = new Date('2026-10-06T16:00:00.000Z');
const vehicle: CachedVehicle = { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Brand', type: 'Type', color: 'Color', tax_due_date: '2026-10-07', stnk_due_date: null, provider_fetched_at: NOW.toISOString() };
const requestId = '00000000-0000-4000-8000-000000000000';
function harness(get: VehicleCacheStore['get']) {
  const lines: string[] = [];
  const tasks: Promise<unknown>[] = [];
  const logger = createSafeLogger(line => lines.push(line));
  const store: VehicleCacheStore = { get, put: vi.fn(async () => undefined) };
  return { lines, tasks, logger, store, read: () => readVehicleCache(store, 'opaque-key', vehicle.nopol, () => NOW, logger, requestId, promise => tasks.push(promise)) };
}
const stream = (value: unknown) => new Response(JSON.stringify(value)).body!;
afterEach(() => vi.useRealTimers());

describe('vehicle cache schema and freshness', () => {
  it('uses the full versioned SHA-256 digest, not plaintext or encryption', async () => {
    const key = await vehicleCacheKey(vehicle.nopol);
    expect(key).toMatch(/^v1:vehicle:[0-9a-f]{64}$/);
    expect(key).not.toContain(vehicle.nopol);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('v1:DH1234ZZ'));
    expect(key).toBe(`v1:vehicle:${Buffer.from(digest).toString('hex')}`);
    expect(await vehicleCacheKey('DH4321ZZ')).not.toBe(key);
  });
  it('accepts canonical dates/null and age strictly less than 300000 ms', () => {
    expect(validateCachedVehicle(vehicle, vehicle.nopol, NOW)).toEqual(vehicle);
    expect(isFreshVehicle(vehicle, new Date(NOW.getTime() + 299999))).toBe(true);
    expect(isFreshVehicle(vehicle, new Date(NOW.getTime() + 300000))).toBe(false);
    expect(isFreshVehicle(vehicle, new Date(NOW.getTime() - 1))).toBe(false);
  });
  it.each([
    null, [], {}, { ...vehicle, nopol: 'DH9999ZZ' }, { ...vehicle, nopol: 'dh1234zz' },
    { ...vehicle, owner_name: '' }, { ...vehicle, brand: 'x'.repeat(201) }, { ...vehicle, type: 'x\u0000' },
    { ...vehicle, color: 1 }, { ...vehicle, color: ' Color ' }, { ...vehicle, owner_name: '\ud800' },
    { ...vehicle, tax_due_date: '07/10/2026' }, { ...vehicle, tax_due_date: '2026-02-29' },
    { ...vehicle, stnk_due_date: '2026-10-07T00:00:00Z' }, { ...vehicle, tax_due_date: undefined },
    { ...vehicle, source: 'CACHE' }, { ...vehicle, tax_status: 'ACTIVE' }, { ...vehicle, NIK: 'FORBIDDEN_SENTINEL' },
    { ...vehicle, provider_fetched_at: '2026-10-06T16:00:00Z' },
    { ...vehicle, provider_fetched_at: '2026-10-06T24:00:00.000Z' },
    { ...vehicle, provider_fetched_at: '2026-02-30T16:00:00.000Z' },
    { ...vehicle, provider_fetched_at: '2026-10-06T16:00:00.001Z' },
    { ...vehicle, provider_fetched_at: '2026-10-06T15:55:00.000Z' },
  ])('rejects untrusted schema %j', value => expect(validateCachedVehicle(value, vehicle.nopol, NOW)).toBeNull());
});

describe('bounded KV I/O and safe logging', () => {
  it('reads stream only and returns a validated hit', async () => {
    const get = vi.fn(async () => stream(vehicle));
    const h = harness(get);
    expect(await h.read()).toEqual(vehicle);
    expect(get).toHaveBeenCalledWith('opaque-key', 'stream');
    expect(h.lines).toEqual([]);
    await Promise.all(h.tasks);
  });
  it('treats absence as a silent miss', async () => {
    const h = harness(async () => null);
    expect(await h.read()).toBeNull(); expect(h.lines).toEqual([]);
  });
  it.each(['{', 'null', '"FORBIDDEN_SENTINEL"', '\ufffd'])('rejects malformed JSON/schema %s', async value => {
    const h = harness(async () => new Response(value).body!);
    expect(await h.read()).toBeNull();
    expect(h.lines.map(line => JSON.parse(line).event)).toEqual(['cache_rejected']);
  });
  it('rejects invalid UTF-8', async () => {
    const h = harness(async () => new Response(new Uint8Array([0xff])).body!);
    expect(await h.read()).toBeNull(); expect(h.lines[0]).toContain('cache_rejected');
  });
  it('caps bytes before decoding and cancels without waiting for cancel resolution', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const h = harness(async () => new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel }));
    expect(await h.read()).toBeNull(); expect(cancel).toHaveBeenCalled();
    expect(h.lines[0]).toContain('cache_rejected');
  });
  it('observes stream failure and rejected cancellation without leaking exceptions', async () => {
    const h = harness(async () => new ReadableStream({ pull(controller) { controller.error(new Error('FORBIDDEN_SENTINEL')); } }));
    expect(await h.read()).toBeNull(); expect(h.lines[0]).toContain('cache_read_failed');
    expect(h.lines.join()).not.toContain('FORBIDDEN_SENTINEL');
  });
  it('bounds a hanging reader at 500 ms and cancels it', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => { throw new Error('FORBIDDEN_SENTINEL'); });
    const h = harness(async () => new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel }));
    const result = h.read();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeNull(); expect(cancel).toHaveBeenCalled();
    expect(h.lines).toHaveLength(1); expect(h.lines[0]).toContain('cache_read_failed');
  });
  it('bounds hanging get and cancels a late stream', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReadableStream<Uint8Array>) => void;
    const cancel = vi.fn();
    const h = harness(() => new Promise(done => { resolve = done; }));
    const result = h.read(); await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBeNull();
    resolve(new ReadableStream({ cancel })); await Promise.all(h.tasks);
    expect(cancel).toHaveBeenCalled();
  });
  it('read rejection is a safe miss', async () => {
    const h = harness(async () => { throw new Error('FORBIDDEN_SENTINEL'); });
    expect(await h.read()).toBeNull();
    expect(JSON.parse(h.lines[0])).toEqual({ event: 'cache_read_failed', request_id: requestId });
  });
  it('writes exact minimal fields with expirationTtl 300 via background work', async () => {
    const h = harness(async () => null);
    writeVehicleCache(h.store, 'opaque-key', vehicle, h.logger, requestId, promise => h.tasks.push(promise));
    await Promise.all(h.tasks);
    expect(h.store.put).toHaveBeenCalledWith('opaque-key', JSON.stringify(vehicle), { expirationTtl: 300 });
    expect(h.lines).toEqual([]);
  });
  it('reports failed writes once and logs only event/request_id', async () => {
    const h = harness(async () => null);
    h.store.put = async () => { throw new Error('FORBIDDEN_SENTINEL'); };
    writeVehicleCache(h.store, 'opaque-key', vehicle, h.logger, requestId, promise => h.tasks.push(promise));
    await Promise.all(h.tasks);
    expect(h.lines.map(line => JSON.parse(line))).toEqual([{ event: 'cache_write_failed', request_id: requestId }]);
  });
  it('bounds write observation and observes a late rejection without duplicate logs', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const h = harness(async () => null);
    h.store.put = () => new Promise((_, fail) => { reject = fail; });
    writeVehicleCache(h.store, 'opaque-key', vehicle, h.logger, requestId, promise => h.tasks.push(promise));
    await vi.advanceTimersByTimeAsync(500);
    expect(h.lines).toHaveLength(1);
    reject(new Error('FORBIDDEN_SENTINEL')); await Promise.all(h.tasks);
    expect(h.lines).toHaveLength(1);
  });
});
