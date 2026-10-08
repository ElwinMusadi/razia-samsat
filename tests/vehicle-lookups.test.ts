import type { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { BpadPublicApiSource, BPAD_MAX_BYTES } from '../worker/vehicle/bpad';
import { vehicleCacheKey, type VehicleCacheStore } from '../worker/vehicle/cache';
import type { Fetcher, VehicleSource } from '../worker/vehicle/contracts';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'https://app.test';
const forbidden = Object.fromEntries(['NIK', 'KTP', 'Alamat', 'BPKB', 'NoRangka', 'NoMesin', 'NOPOL_EKS', 'Kohir', 'address', 'chassis', 'engine', 'raw'].map(key => [key, 'FORBIDDEN_SENTINEL']));
const fixture = { kode: '1', status: 'success', NOPOL: 'DH1234ZZ', NamaPemilik: 'Synthetic Owner', Merk: 'Synthetic Brand', Type: 'Synthetic Type', Warna: 'Synthetic Color', SD_NOTICE: '07/10/2026', SD_STNK: '2026-10-08', ...forbidden };
const cacheValue = { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2026-10-08', provider_fetched_at: '2026-10-06T16:00:00.000Z' };
let mf: Miniflare;
let db: TestD1;
let kv: VehicleCacheStore;
let kvNamespace: KVNamespace;
let token: string;
let sessionId: string;
let now: Date;
let fetcher: ReturnType<typeof vi.fn<Fetcher>>;
let app: ReturnType<typeof createApp>;
let tasks: Promise<unknown>[];
let lines: string[];
let store: VehicleCacheStore;
let dbOverride: D1Database | undefined;
let futureExpiry: boolean;
let expectedHistory: number;
const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
const historyCount = () => db.prepare('SELECT count(*) AS n FROM check_logs').first<number>('n');
const clock = () => now;
function configure(source: VehicleSource = new BpadPublicApiSource(fetcher, clock)): void {
  app = createApp(createSafeLogger(line => lines.push(line)), { source, clock, cache: store });
}
function environment(): Env {
  return { DB: dbOverride ?? db, VEHICLE_CACHE: kv, PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' } as unknown as Env;
}
function call(body: unknown = { nopol: 'DH1234ZZ' }, cookie: string | null = token, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request(`${ORIGIN}/api/vehicle-lookups`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: `__Host-rs_session=${cookie}` } : {}), ...headers },
  }, environment(), { waitUntil(promise: Promise<unknown>) { tasks.push(promise); }, passThroughOnException() {}, props: {} }));
}
async function error(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ error: { code, request_id: response.headers.get('x-request-id') } });
  expect(JSON.stringify(body)).not.toContain('FORBIDDEN_SENTINEL');
}
async function seed(role: 'ADMIN' | 'OFFICER' = 'OFFICER', raid = true): Promise<void> {
  token = generateSessionToken(); sessionId = crypto.randomUUID();
  await sql('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', 'user', 'synthetic.user', 'unused-synthetic-hash', role);
  await sql('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200)', sessionId, 'user', await hashSessionToken(token));
  if (raid) await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid','user','location','A')");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function expiryProxy(): void {
  const real = db as unknown as D1Database;
  dbOverride = { prepare(query: string) {
    return real.prepare(futureExpiry && query.includes('s.id = ? AND s.user_id = ?') ? query.replace('s.expires_at > unixepoch()', 's.expires_at > (unixepoch()+43201)') : query);
  } } as D1Database;
}

beforeAll(async () => { ({ mf, db } = await startMigratedD1({ modules: true, script: 'export default {fetch(){return new Response("test")}}', kvNamespaces: ['VEHICLE_CACHE'] })); kvNamespace = await mf.getKVNamespace('VEHICLE_CACHE') as unknown as KVNamespace; kv = kvNamespace; });
beforeEach(async () => {
  await resetTestD1(db);
  await sql("INSERT INTO locations(id,name) VALUES('location','Synthetic location')");
  await kvNamespace.delete(await vehicleCacheKey('DH1234ZZ'));
  now = new Date('2026-10-06T16:00:00.000Z'); lines = []; tasks = []; dbOverride = undefined; futureExpiry = false; expectedHistory = 0;
  fetcher = vi.fn<Fetcher>(async () => Response.json(fixture));
  store = { get: vi.fn((key, type) => kv.get(key, type)), put: vi.fn((key, value, options) => kv.put(key, value, options)) };
  configure(); await seed();
});
afterEach(async () => { await Promise.all(tasks); expect(await historyCount()).toBe(expectedHistory); vi.useRealTimers(); });
afterAll(async () => { await mf?.dispose(); });

describe('lookup contract and provider minimization with real D1/KV', () => {
  it.each(['OFFICER', 'ADMIN'] as const)('allows %s own active raid, returns LIVE then CACHE with exact allowlists', async role => {
    expectedHistory = 1;
    await sql('UPDATE users SET role=? WHERE id=?', role, 'user');
    const response = await call({ nopol: ' dh 1234 zz ' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ outcome: 'FOUND', vehicle: { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2026-10-08', tax_status: 'EXPIRED', stnk_status: 'ACTIVE' }, source: 'LIVE', fetched_at: now.toISOString(), evaluated_on: '2026-10-07', request_id: response.headers.get('x-request-id') });
    expect(JSON.stringify(body)).not.toContain('FORBIDDEN_SENTINEL');
    await Promise.all(tasks);
    expect(store.put).toHaveBeenCalledWith(await vehicleCacheKey('DH1234ZZ'), JSON.stringify(cacheValue), { expirationTtl: 300 });
    const cached = await call(); expect(await cached.json()).toMatchObject({ source: 'CACHE', fetched_at: now.toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(store.get).toHaveBeenCalledWith(await vehicleCacheKey('DH1234ZZ'), 'stream');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ body: '{"nopol":"DH1234ZZ"}', redirect: 'manual' });
  });
  it('recalculates cached status across WITA midnight rather than storing computed status', async () => {
    expectedHistory = 1;
    now = new Date('2026-10-06T15:59:59.999Z');
    const first = await call(); expect(await first.json()).toMatchObject({ evaluated_on: '2026-10-06', vehicle: { tax_status: 'ACTIVE' } });
    await Promise.all(tasks); now = new Date('2026-10-06T16:00:00.000Z');
    expect(await (await call()).json()).toMatchObject({ source: 'CACHE', evaluated_on: '2026-10-07', vehicle: { tax_status: 'EXPIRED' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([['2026-10-06', 'EXPIRED'], ['2026-10-07', 'EXPIRED'], ['2026-10-08', 'ACTIVE'], [null, 'UNKNOWN'], ['2026-02-29', 'UNKNOWN'], ['10-07-2026', 'UNKNOWN']])('evaluates due date %j as %s', async (date, status) => {
    expectedHistory = 1;
    fetcher.mockImplementation(async () => Response.json({ ...fixture, SD_NOTICE: date, SD_STNK: date }));
    expect(await (await call()).json()).toMatchObject({ vehicle: { tax_status: status, stnk_status: status, tax_due_date: status === 'UNKNOWN' ? null : date } });
  });
  it('returns generic verified NOT_FOUND without vehicle or cache write', async () => {
    expectedHistory = 1;
    fetcher.mockImplementation(async () => Response.json({ kode: '0', status: 'failed', pesan: 'FORBIDDEN_SENTINEL DH1234ZZ' }));
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'NOT_FOUND', request_id: response.headers.get('x-request-id') });
    expect(store.put).not.toHaveBeenCalled();
  });
  it('projects custom source extras and never stores or exposes them', async () => {
    expectedHistory = 1;
    configure({ lookup: async () => ({ outcome: 'FOUND', vehicle: { ...cacheValue, ...forbidden, source: 'LIVE' } }) });
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('FORBIDDEN_SENTINEL');
    await Promise.all(tasks); expect(JSON.stringify(vi.mocked(store.put).mock.calls)).not.toContain('FORBIDDEN_SENTINEL');
  });
  it.each([{ source: 'CACHE' }, { nopol: 'DH9999ZZ' }, { tax_due_date: '2026-02-29' }, { owner_name: 'x'.repeat(201) }, { provider_fetched_at: '2026-10-06T16:00:00.001Z' }])('rejects malformed custom normalized source %j', async patch => {
    configure({ lookup: async () => ({ outcome: 'FOUND', vehicle: { ...cacheValue, source: 'LIVE', ...patch } }) } as VehicleSource);
    await error(await call(), 502, 'UPSTREAM_MALFORMED'); expect(store.put).not.toHaveBeenCalled();
  });
});

describe('input and authorization gates without provider/cache/history work', () => {
  it.each(['{', 'null', '[]', {}, { nopol: '' }, { nopol: 1 }, { nopol: null }, { nopol: 'DH-1234ZZ' }, { nopol: 'x'.repeat(65) }, ...['user_id', 'session_id', 'raid_session_id', 'sessionId', 'extra'].map(key => ({ nopol: 'DH1234ZZ', [key]: 'injected' }))])('rejects invalid or extra body %j', async body => {
    await error(await call(body), 400, 'INVALID_INPUT'); expect(fetcher).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
  });
  it('retains same-origin CSRF and 4096-byte body cap', async () => {
    await error(await call({}, token, { Origin: 'https://evil.test' }), 403, 'CSRF_REJECTED');
    await error(await call({ nopol: 'x'.repeat(5000) }), 413, 'PAYLOAD_TOO_LARGE');
    expect(fetcher).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
  });
  it.each(['missing', 'malformed', 'revoked', 'expired', 'inactive'] as const)('rejects %s auth with 401 and no lookup I/O', async state => {
    let cookie: string | null = token;
    if (state === 'missing') cookie = null;
    if (state === 'malformed') cookie = 'invalid';
    if (state === 'revoked') await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
    if (state === 'inactive') await sql("UPDATE users SET is_active=0 WHERE id='user'");
    if (state === 'expired') {
      await sql('DELETE FROM user_sessions');
      await sql('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,1,2)', sessionId, 'user', await hashSessionToken(token));
    }
    const response = await call(undefined, cookie); await error(response, 401, 'AUTHENTICATION_ERROR');
    if (state !== 'missing') expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetcher).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
  });
  it.each(['absent', 'closed', 'other owner'] as const)('requires own active raid, not %s', async state => {
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
    if (state === 'absent') await sql('DELETE FROM raid_sessions');
    if (state === 'other owner') {
      await sql("INSERT INTO users(id,username,password_hash,role) VALUES('other','synthetic.other','unused','OFFICER')");
      await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('other-raid','other','location','A')");
    }
    await error(await call(), 409, 'RAID_SESSION_REQUIRED'); expect(fetcher).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
  });
  it('does not invent invalidation when an existing raid location is inactive', async () => {
    expectedHistory = 1;
    await sql("UPDATE locations SET is_active=0 WHERE id='location'"); expect((await call()).status).toBe(200);
  });
  it('rechecks exact auth in the initial raid snapshot after middleware', async () => {
    const real = db as unknown as D1Database;
    dbOverride = { prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes('LEFT JOIN raid_sessions')) return statement;
      return { bind(...values: (string | number | null)[]) { return { async first() {
        await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
        return statement.bind(...values).first();
      } }; } } as D1PreparedStatement;
    } } as D1Database;
    await error(await call(), 401, 'AUTHENTICATION_ERROR'); expect(store.get).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('post-await exact session and captured raid', () => {
  it.each(['provider', 'cache'] as const)('blocks revoked/expired/deactivated/closed-replaced results during %s await', async boundary => {
    for (const state of ['revoked', 'expired', 'inactive', 'closed-replaced'] as const) {
      // Restore only test data; immutable sessions are replaced, never extended/reactivated.
      await sql('DELETE FROM raid_sessions'); await sql('DELETE FROM user_sessions'); await sql('DELETE FROM users'); await seed('ADMIN');
      futureExpiry = false; expiryProxy(); tasks = [];
      const started = deferred<void>(); const release = deferred<void>();
      if (boundary === 'provider') { store.get = async () => null; fetcher.mockImplementation(async () => { started.resolve(); await release.promise; return Response.json(fixture); }); }
      else { store.get = async () => { started.resolve(); await release.promise; return new Response(JSON.stringify(cacheValue)).body!; }; }
      configure(); const result = call(); await started.promise;
      if (state === 'revoked') {
        // Another ADMIN session cannot replace the cookie's exact session.
        await sql('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200)', 'other-session', 'user', 'b'.repeat(64));
        await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
      }
      if (state === 'expired') futureExpiry = true;
      if (state === 'inactive') await sql("UPDATE users SET is_active=0 WHERE id='user'");
      if (state === 'closed-replaced') {
        await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
        await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('new-raid','user','location','B')");
      }
      release.resolve(); const response = await result;
      await error(response, state === 'closed-replaced' ? 409 : 401, state === 'closed-replaced' ? 'RAID_SESSION_REQUIRED' : 'AUTHENTICATION_ERROR');
      if (state !== 'closed-replaced') expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
      expect(store.put).not.toHaveBeenCalled(); await Promise.all(tasks);
    }
  });
  it('rechecks NOT_FOUND after async provider work', async () => {
    fetcher.mockImplementation(async () => { await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId); return Response.json({ kode: '0', status: 'failed' }); });
    await error(await call(), 401, 'AUTHENTICATION_ERROR'); expect(store.put).not.toHaveBeenCalled();
  });
  it('accepts revocation after the final D1 snapshot without promising global cancellation', async () => {
    const real = db as unknown as D1Database; let reads = 0;
    dbOverride = { prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes('LEFT JOIN raid_sessions')) return statement;
      return { bind(...values: (string | number | null)[]) { return { async first() {
        const row = await statement.bind(...values).first(); reads++;
        if (reads === 3) await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
        return row;
      } }; } } as D1PreparedStatement;
    } } as D1Database;
    expectedHistory = 1;
    expect((await call()).status).toBe(200);
  });
});

describe('KV poison, freshness and failure fallback', () => {
  it.each([{ ...cacheValue, NIK: 'FORBIDDEN_SENTINEL' }, { ...cacheValue, source: 'LIVE' }, { ...cacheValue, tax_status: 'EXPIRED' }, { ...cacheValue, nopol: 'DH4321ZZ' }, { ...cacheValue, tax_due_date: '2026-02-29' }, { ...cacheValue, provider_fetched_at: '2026-10-06T15:55:00.000Z' }, { ...cacheValue, provider_fetched_at: '2026-10-06T16:00:00.001Z' }, '{'])('rejects poisoned/stale cache %j and falls back LIVE', async value => {
    expectedHistory = 1;
    await kv.put(await vehicleCacheKey('DH1234ZZ'), typeof value === 'string' ? value : JSON.stringify(value), { expirationTtl: 300 });
    expect(await (await call()).json()).toMatchObject({ source: 'LIVE' }); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(lines.some(line => line.includes('cache_rejected'))).toBe(true);
  });
  it('caps oversize actual KV before decode and falls back LIVE', async () => {
    expectedHistory = 1;
    await kv.put(await vehicleCacheKey('DH1234ZZ'), 'x'.repeat(4097), { expirationTtl: 300 });
    expect(await (await call()).json()).toMatchObject({ source: 'LIVE' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rechecks cache freshness after authorization snapshot and reloads once', async () => {
    expectedHistory = 1;
    await kv.put(await vehicleCacheKey('DH1234ZZ'), JSON.stringify(cacheValue), { expirationTtl: 300 });
    const real = db as unknown as D1Database; let reads = 0;
    dbOverride = { prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes('LEFT JOIN raid_sessions')) return statement;
      return { bind(...values: (string | number | null)[]) { return { async first() {
        const row = await statement.bind(...values).first(); if (++reads === 2) now = new Date(now.getTime()+300000); return row;
      } }; } } as D1PreparedStatement;
    } } as D1Database;
    expect(await (await call()).json()).toMatchObject({ source: 'LIVE', fetched_at: '2026-10-06T16:05:00.000Z' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['read', 'write'] as const)('KV %s rejection does not break LIVE response or leak logs', async operation => {
    expectedHistory = 1;
    store[operation === 'read' ? 'get' : 'put'] = async () => { throw new Error('FORBIDDEN_SENTINEL DH1234ZZ Synthetic Owner'); };
    configure(); expect(await (await call()).json()).toMatchObject({ source: 'LIVE' }); await Promise.all(tasks);
    expect(lines.some(line => line.includes(`cache_${operation}_failed`))).toBe(true);
    for (const line of lines) { expect(Object.keys(JSON.parse(line)).every(key => ['event', 'request_id', 'code'].includes(key))).toBe(true); expect(line).not.toMatch(/FORBIDDEN_SENTINEL|DH1234ZZ|Synthetic Owner/); }
  });
});

describe('KV bounded latency and reauthorization before provider', () => {
  it('falls back LIVE within the 500 ms KV deadline when read never settles, then cleans late stream', async () => {
    expectedHistory = 1;
    const release = deferred<ReadableStream<Uint8Array>>(); const cancel = vi.fn();
    store.get = () => release.promise; configure();
    const start = Date.now(); const response = await call();
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ source: 'LIVE' });
    expect(Date.now()-start).toBeLessThan(2000); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(lines.some(line => line.includes('cache_read_failed'))).toBe(true);
    release.resolve(new ReadableStream({ cancel })); await Promise.all(tasks); expect(cancel).toHaveBeenCalled();
  });
  it('hanging background write does not delay response and logs its deadline', async () => {
    expectedHistory = 1;
    const release = deferred<void>(); store.put = () => release.promise; configure();
    const start = Date.now(); const response = await call(); expect(response.status).toBe(200);
    expect(Date.now()-start).toBeLessThan(500);
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(lines.some(line => line.includes('cache_write_failed'))).toBe(true); release.resolve();
  });
  it('cache miss cannot invoke provider after auth was invalidated during KV work', async () => {
    store.get = async () => { await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId); return null; }; configure();
    await error(await call(), 401, 'AUTHENTICATION_ERROR'); expect(fetcher).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
  });
  it('cache miss cannot rebind to a new raid before provider call', async () => {
    store.get = async () => {
      await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
      await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('new-raid','user','location','B')"); return null;
    }; configure();
    await error(await call(), 409, 'RAID_SESSION_REQUIRED'); expect(fetcher).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
  });
});

describe('provider error budget never becomes NOT_FOUND or cache', () => {
  it.each([404, 502, 301, 302, 307, 308])('keeps HTTP %i as 502 upstream error', async status => {
    fetcher.mockImplementation(async () => new Response('FORBIDDEN_SENTINEL', { status }));
    await error(await call(), 502, 'UPSTREAM_ERROR'); expect(store.put).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['<html>FORBIDDEN_SENTINEL</html>', '{', JSON.stringify({ ...fixture, kode: '0' })])('rejects nonJSON/malformed %s', async value => {
    fetcher.mockImplementation(async () => new Response(value)); await error(await call(), 502, 'UPSTREAM_MALFORMED'); expect(store.put).not.toHaveBeenCalled();
  });
  it('keeps network errors generic', async () => {
    fetcher.mockImplementation(async () => { throw new Error('FORBIDDEN_SENTINEL'); }); await error(await call(), 502, 'UPSTREAM_NETWORK'); expect(store.put).not.toHaveBeenCalled();
  });
  it('rejects oversized provider body without cache write', async () => {
    fetcher.mockImplementation(async () => new Response('x'.repeat(BPAD_MAX_BYTES+1))); await error(await call(), 502, 'UPSTREAM_MALFORMED'); expect(store.put).not.toHaveBeenCalled();
  });
  it('preserves 3000 ms total timeout through a never-ending body', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    fetcher.mockImplementation(async () => new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel })));
    const start = Date.now(); await error(await call(), 504, 'TIMEOUT');
    expect(Date.now()-start).toBeLessThan(4500); expect(cancel).toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  }, 10000);
});
