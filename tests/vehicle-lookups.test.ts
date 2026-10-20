import type { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { BpadPublicApiSource, BPAD_MAX_BYTES } from '../worker/vehicle/bpad';
import type { Fetcher, VehicleSource } from '../worker/vehicle/contracts';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'https://app.test';
const forbidden = Object.fromEntries(['NIK', 'KTP', 'Alamat', 'BPKB', 'NoRangka', 'NoMesin', 'NOPOL_EKS', 'Kohir', 'address', 'chassis', 'engine', 'raw'].map(key => [key, 'FORBIDDEN_SENTINEL']));
const fixture = { kode: '1', status: 'success', NOPOL: 'DH1234ZZ', NamaPemilik: 'Synthetic Owner', Merk: 'Synthetic Brand', Type: 'Synthetic Type', Warna: 'Synthetic Color', SD_NOTICE: '07/10/2026', SD_STNK: '2026-10-08', ...forbidden };
const normalized = { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2026-10-08', provider_fetched_at: '2026-10-06T16:00:00.000Z', snapshot_synced_at: null };
let mf: Miniflare;
let db: TestD1;
let kv: KVNamespace;
let token: string;
let sessionId: string;
let now: Date;
let fetcher: ReturnType<typeof vi.fn<Fetcher>>;
let app: ReturnType<typeof createApp>;
let tasks: Promise<unknown>[];
let lines: string[];
let dbOverride: D1Database | undefined;
let futureExpiry: boolean;
let expectedHistory: number;
// Every KV access is a policy violation; the binding stays attached but unused.
const kvAccess = { get: 0, put: 0, list: 0, delete: 0 };
const kvProxy = new Proxy({}, { get(_target, property) { return () => { kvAccess[property as keyof typeof kvAccess]++; throw new Error('KV access forbidden'); }; } }) as unknown as KVNamespace;
const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
const historyCount = () => db.prepare('SELECT count(*) AS n FROM check_logs').first<number>('n');
const clock = () => now;
function configure(source: VehicleSource = new BpadPublicApiSource(fetcher, clock)): void {
  app = createApp(createSafeLogger(line => lines.push(line)), { sources: { BPAD: source }, clock });
}
function environment(): Env {
  return { DB: dbOverride ?? db, VEHICLE_CACHE: kvProxy, PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' } as unknown as Env;
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

beforeAll(async () => { ({ mf, db } = await startMigratedD1({ modules: true, script: 'export default {fetch(){return new Response("test")}}', kvNamespaces: ['VEHICLE_CACHE'] })); kv = await mf.getKVNamespace('VEHICLE_CACHE') as unknown as KVNamespace; });
beforeEach(async () => {
  await resetTestD1(db);
  await sql("INSERT INTO locations(id,name) VALUES('location','Synthetic location')");
  now = new Date('2026-10-06T16:00:00.000Z'); lines = []; tasks = []; dbOverride = undefined; futureExpiry = false; expectedHistory = 0;
  for (const key of Object.keys(kvAccess) as (keyof typeof kvAccess)[]) kvAccess[key] = 0;
  fetcher = vi.fn<Fetcher>(async () => Response.json(fixture));
  configure(); await seed();
});
afterEach(async () => {
  await Promise.all(tasks); expect(await historyCount()).toBe(expectedHistory); vi.useRealTimers();
  // Zero cache access on every path, and the real namespace stays empty.
  expect(kvAccess).toEqual({ get: 0, put: 0, list: 0, delete: 0 });
  expect((await kv.list()).keys).toEqual([]);
});
afterAll(async () => { await mf?.dispose(); });

describe('lookup contract and provider minimization with real D1 (no cache)', () => {
  it.each(['OFFICER', 'ADMIN'] as const)('allows %s own active raid and returns the exact LIVE/BPAD allowlist', async role => {
    expectedHistory = 1;
    await sql('UPDATE users SET role=? WHERE id=?', role, 'user');
    const response = await call({ nopol: ' dh 1234 zz ' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ outcome: 'FOUND', vehicle: { nopol: 'DH1234ZZ', owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2026-10-08', tax_status: 'EXPIRED', stnk_status: 'ACTIVE' }, source: 'LIVE', provider: 'BPAD', fetched_at: now.toISOString(), snapshot_synced_at: null, evaluated_on: '2026-10-07', request_id: response.headers.get('x-request-id') });
    expect(JSON.stringify(body)).not.toContain('FORBIDDEN_SENTINEL');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ body: '{"nopol":"DH1234ZZ"}', redirect: 'manual' });
  });
  it('two lookups of the same plate make two upstream requests and keep one history snapshot', async () => {
    expectedHistory = 1;
    const first = await call(); expect(first.status).toBe(200); await Promise.all(tasks);
    const snapshot = await db.prepare('SELECT * FROM check_logs').first();
    now = new Date('2026-10-06T16:00:01.000Z');
    const second = await call(); expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ source: 'LIVE', provider: 'BPAD', fetched_at: '2026-10-06T16:00:01.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => init.body)).toEqual(['{"nopol":"DH1234ZZ"}', '{"nopol":"DH1234ZZ"}']);
    await Promise.all(tasks);
    expect(await db.prepare('SELECT * FROM check_logs').first()).toEqual(snapshot);
    expect(snapshot).toMatchObject({ source: 'LIVE', provider: 'BPAD' });
  });
  it('recalculates status on every lookup across WITA midnight from fresh upstream data', async () => {
    expectedHistory = 1;
    now = new Date('2026-10-06T15:59:59.999Z');
    const first = await call(); expect(await first.json()).toMatchObject({ evaluated_on: '2026-10-06', vehicle: { tax_status: 'ACTIVE' } });
    await Promise.all(tasks); now = new Date('2026-10-06T16:00:00.000Z');
    expect(await (await call()).json()).toMatchObject({ source: 'LIVE', evaluated_on: '2026-10-07', vehicle: { tax_status: 'EXPIRED' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([['2026-10-06', 'EXPIRED'], ['2026-10-07', 'EXPIRED'], ['2026-10-08', 'ACTIVE'], [null, 'UNKNOWN'], ['2026-02-29', 'UNKNOWN'], ['10-07-2026', 'UNKNOWN']])('evaluates due date %j as %s', async (date, status) => {
    expectedHistory = 1;
    fetcher.mockImplementation(async () => Response.json({ ...fixture, SD_NOTICE: date, SD_STNK: date }));
    expect(await (await call()).json()).toMatchObject({ vehicle: { tax_status: status, stnk_status: status, tax_due_date: status === 'UNKNOWN' ? null : date } });
  });
  it('returns generic verified NOT_FOUND with provider and without vehicle data', async () => {
    expectedHistory = 1;
    fetcher.mockImplementation(async () => Response.json({ kode: '0', status: 'failed', pesan: 'FORBIDDEN_SENTINEL DH1234ZZ' }));
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'NOT_FOUND', provider: 'BPAD', request_id: response.headers.get('x-request-id') });
    await Promise.all(tasks);
    expect(await db.prepare('SELECT outcome, source, provider FROM check_logs').first()).toEqual({ outcome: 'NOT_FOUND', source: 'LIVE', provider: 'BPAD' });
  });
  it('projects custom source extras and never exposes them', async () => {
    expectedHistory = 1;
    configure({ lookup: async () => ({ outcome: 'FOUND', vehicle: { ...normalized, ...forbidden, source: 'LIVE' } }) });
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('FORBIDDEN_SENTINEL');
  });
  it('accepts explicit null identity fields from a normalized source and records null vehicle facts', async () => {
    expectedHistory = 1;
    configure({ lookup: async () => ({ outcome: 'FOUND', vehicle: { ...normalized, owner_name: null, brand: null, type: null, color: null, source: 'LIVE' } }) });
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ vehicle: { owner_name: null, brand: null, type: null, color: null } });
    await Promise.all(tasks);
    expect(await db.prepare('SELECT vehicle_brand, vehicle_type, vehicle_color FROM check_logs').first()).toEqual({ vehicle_brand: null, vehicle_type: null, vehicle_color: null });
  });
  it.each([{ source: 'CACHE' }, { nopol: 'DH9999ZZ' }, { tax_due_date: '2026-02-29' }, { owner_name: 'x'.repeat(201) }, { owner_name: '' }, { brand: undefined }, { provider_fetched_at: '2026-10-06T16:00:00Z' }, { snapshot_synced_at: '2026-10-05T00:00:00.000Z' }, { snapshot_synced_at: undefined }])('rejects malformed custom normalized source %j', async patch => {
    configure({ lookup: async () => ({ outcome: 'FOUND', vehicle: { ...normalized, source: 'LIVE', ...patch } }) } as unknown as VehicleSource);
    await error(await call(), 502, 'UPSTREAM_MALFORMED');
  });
});

describe('input and authorization gates without provider/history work', () => {
  it.each(['{', 'null', '[]', {}, { nopol: '' }, { nopol: 1 }, { nopol: null }, { nopol: 'DH-1234ZZ' }, { nopol: 'x'.repeat(65) }, ...['user_id', 'session_id', 'raid_session_id', 'sessionId', 'provider', 'extra'].map(key => ({ nopol: 'DH1234ZZ', [key]: 'injected' }))])('rejects invalid or extra body %j', async body => {
    await error(await call(body), 400, 'INVALID_INPUT'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains same-origin CSRF and 4096-byte body cap', async () => {
    await error(await call({}, token, { Origin: 'https://evil.test' }), 403, 'CSRF_REJECTED');
    await error(await call({ nopol: 'x'.repeat(5000) }), 413, 'PAYLOAD_TOO_LARGE');
    expect(fetcher).not.toHaveBeenCalled();
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
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['absent', 'closed', 'other owner'] as const)('requires own active raid, not %s', async state => {
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
    if (state === 'absent') await sql('DELETE FROM raid_sessions');
    if (state === 'other owner') {
      await sql("INSERT INTO users(id,username,password_hash,role) VALUES('other','synthetic.other','unused','OFFICER')");
      await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('other-raid','other','location','A')");
    }
    await error(await call(), 409, 'RAID_SESSION_REQUIRED'); expect(fetcher).not.toHaveBeenCalled();
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
    await error(await call(), 401, 'AUTHENTICATION_ERROR'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed with 503 and no upstream call when the global setting row is missing', async () => {
    const real = db as unknown as D1Database;
    dbOverride = { prepare(query: string) { return real.prepare(query.replace('(SELECT provider FROM vehicle_source_settings ORDER BY version DESC LIMIT 1)', '(SELECT provider FROM vehicle_source_settings WHERE 0)')); } } as D1Database;
    await error(await call(), 503, 'VEHICLE_SOURCE_UNAVAILABLE'); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('post-await exact session and captured raid', () => {
  it('blocks revoked/expired/deactivated/closed-replaced results during provider await', async () => {
    for (const state of ['revoked', 'expired', 'inactive', 'closed-replaced'] as const) {
      // Restore only test data; immutable sessions are replaced, never extended/reactivated.
      await sql('DELETE FROM raid_sessions'); await sql('DELETE FROM user_sessions'); await sql('DELETE FROM users'); await seed('ADMIN');
      futureExpiry = false; expiryProxy(); tasks = [];
      const started = deferred<void>(); const release = deferred<void>();
      fetcher.mockImplementation(async () => { started.resolve(); await release.promise; return Response.json(fixture); });
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
      await Promise.all(tasks);
    }
  });
  it('rechecks NOT_FOUND after async provider work', async () => {
    fetcher.mockImplementation(async () => { await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId); return Response.json({ kode: '0', status: 'failed' }); });
    await error(await call(), 401, 'AUTHENTICATION_ERROR');
  });
  it('accepts revocation after the final D1 snapshot without promising global cancellation', async () => {
    const real = db as unknown as D1Database; let reads = 0;
    dbOverride = { prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes('LEFT JOIN raid_sessions')) return statement;
      return { bind(...values: (string | number | null)[]) { return { async first() {
        const row = await statement.bind(...values).first(); reads++;
        if (reads === 2) await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
        return row;
      } }; } } as D1PreparedStatement;
    } } as D1Database;
    expectedHistory = 1;
    expect((await call()).status).toBe(200);
  });
});

describe('provider error budget never becomes NOT_FOUND', () => {
  it.each([404, 502, 301, 302, 307, 308])('keeps HTTP %i as 502 upstream error', async status => {
    fetcher.mockImplementation(async () => new Response('FORBIDDEN_SENTINEL', { status }));
    await error(await call(), 502, 'UPSTREAM_ERROR'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['<html>FORBIDDEN_SENTINEL</html>', '{', JSON.stringify({ ...fixture, kode: '0' })])('rejects nonJSON/malformed %s', async value => {
    fetcher.mockImplementation(async () => new Response(value)); await error(await call(), 502, 'UPSTREAM_MALFORMED');
  });
  it('keeps network errors generic', async () => {
    fetcher.mockImplementation(async () => { throw new Error('FORBIDDEN_SENTINEL'); }); await error(await call(), 502, 'UPSTREAM_NETWORK');
  });
  it('rejects oversized provider body', async () => {
    fetcher.mockImplementation(async () => new Response('x'.repeat(BPAD_MAX_BYTES+1))); await error(await call(), 502, 'UPSTREAM_MALFORMED');
  });
  it('preserves 3000 ms total timeout through a never-ending body', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    fetcher.mockImplementation(async () => new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel })));
    const start = Date.now(); await error(await call(), 504, 'TIMEOUT');
    expect(Date.now()-start).toBeLessThan(4500); expect(cancel).toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  }, 10000);
  it('logs only allowlisted events without plates, owners or cache events', async () => {
    fetcher.mockImplementation(async () => { throw new Error('FORBIDDEN_SENTINEL DH1234ZZ Synthetic Owner'); });
    await error(await call(), 502, 'UPSTREAM_NETWORK');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line)).every(key => ['event', 'request_id', 'code'].includes(key))).toBe(true);
      expect(line).not.toMatch(/FORBIDDEN_SENTINEL|DH1234ZZ|Synthetic Owner|cache/);
    }
  });
});
