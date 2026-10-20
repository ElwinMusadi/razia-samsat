import { readdir, readFile } from 'node:fs/promises';
import type { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import type { VehicleResult, VehicleSource } from '../worker/vehicle/contracts';
import { parseVehicleSourceSetting } from '../worker/vehicle/source';
import { applyTestMigrations, clearVehicleSourceChanges, resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'https://app.test';
const ADMIN = '00000000-0000-4000-8000-000000000001';
const OTHER_ADMIN = '00000000-0000-4000-8000-000000000002';
const OFFICER = '00000000-0000-4000-8000-000000000003';
const SECOND_OFFICER = '00000000-0000-4000-8000-000000000004';
const NOW = new Date('2026-10-20T01:00:00.000Z');
let mf: Miniflare, db: TestD1, app: ReturnType<typeof createApp>;
let tasks: Promise<unknown>[], lines: string[], env: Record<string, unknown>;
let tokens: Record<string, string>;
let bpad: ReturnType<typeof vi.fn<VehicleSource['lookup']>>, potensi: ReturnType<typeof vi.fn<VehicleSource['lookup']>>;
const kvAccess = { count: 0 };
const kvProxy = new Proxy({}, { get() { return () => { kvAccess.count++; throw new Error('KV access forbidden'); }; } }) as unknown as KVNamespace;
const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
function found(nopol: unknown, provider: 'BPAD' | 'POTENSI_NTT'): VehicleResult {
  return { outcome: 'FOUND', vehicle: { nopol: String(nopol), owner_name: provider === 'BPAD' ? 'Owner Live' : null, brand: 'Brand', type: 'Type', color: 'Color', tax_due_date: '2026-12-31', stnk_due_date: null,
    provider_fetched_at: NOW.toISOString(), snapshot_synced_at: provider === 'POTENSI_NTT' ? '2026-10-18T00:00:00.000Z' : null, source: 'LIVE' } };
}
function configure(): void {
  app = createApp(createSafeLogger(line => lines.push(line)), { sources: { BPAD: { lookup: bpad }, POTENSI_NTT: { lookup: potensi } }, clock: () => NOW });
}
function request(path: string, init: { method?: string; body?: unknown; who?: string; raw?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const who = init.who ?? 'admin';
  return Promise.resolve(app.request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET', body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    headers: { ...(init.method && init.method !== 'GET' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...(who === 'none' ? {} : { Cookie: `__Host-rs_session=${tokens[who]}` }), ...init.headers },
  }, env as unknown as Env, { waitUntil(promise: Promise<unknown>) { tasks.push(promise); }, passThroughOnException() {}, props: {} }));
}
const lookup = (who: string, nopol = 'DH1234ZZ') => request('/api/vehicle-lookups', { method: 'POST', body: { nopol }, who });
const put = (body: unknown, who = 'admin') => request('/api/admin/vehicle-source', { method: 'PUT', body, who });
const current = () => db.prepare('SELECT version, provider, updated_by FROM vehicle_source_settings ORDER BY version DESC').all<Record<string, unknown>>().then((r: D1Result<Record<string, unknown>>) => r.results);
async function error(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: { code, request_id: response.headers.get('x-request-id') } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeAll(async () => { ({ mf, db } = await startMigratedD1()); });
beforeEach(async () => {
  await resetTestD1(db);
  tasks = []; lines = []; kvAccess.count = 0;
  env = { DB: db, VEHICLE_CACHE: kvProxy, PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' };
  tokens = { admin: generateSessionToken(), other: generateSessionToken(), officer: generateSessionToken(), second: generateSessionToken() };
  await db.batch([
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.admin','unused','ADMIN'),(?,'synthetic.other','unused','ADMIN'),(?,'synthetic.officer','unused','OFFICER'),(?,'synthetic.second','unused','OFFICER')").bind(ADMIN, OTHER_ADMIN, OFFICER, SECOND_OFFICER),
    db.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')"),
    db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200),(?,?,?,unixepoch()+43200),(?,?,?,unixepoch()+43200),(?,?,?,unixepoch()+43200)')
      .bind('s-admin', ADMIN, await hashSessionToken(tokens.admin), 's-other', OTHER_ADMIN, await hashSessionToken(tokens.other), 's-officer', OFFICER, await hashSessionToken(tokens.officer), 's-second', SECOND_OFFICER, await hashSessionToken(tokens.second)),
    db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid-officer',?,'location','A'),('raid-second',?,'location','B')").bind(OFFICER, SECOND_OFFICER),
  ]);
  bpad = vi.fn(async nopol => found(nopol, 'BPAD')); potensi = vi.fn(async nopol => found(nopol, 'POTENSI_NTT'));
  configure();
});
afterEach(async () => { await Promise.all(tasks); expect(kvAccess.count).toBe(0); });
afterAll(async () => { await mf?.dispose(); });

describe('0005 migration on actual D1', () => {
  it('fresh schema seeds exactly one BPAD row without actor and adds the nullable check_logs.provider column', async () => {
    expect(await current()).toEqual([{ version: 1, provider: 'BPAD', updated_by: null }]);
    const columns = (await db.prepare('PRAGMA table_info(vehicle_source_settings)').all<{ name: string; notnull: number }>()).results;
    expect(columns.map((column: { name: string }) => column.name)).toEqual(['version', 'provider', 'updated_by', 'updated_at']);
    const fk = (await db.prepare('PRAGMA foreign_key_list(vehicle_source_settings)').all<{ table: string; on_delete: string }>()).results;
    expect(fk).toEqual([expect.objectContaining({ table: 'users', on_delete: 'RESTRICT' })]);
    expect((await db.prepare('PRAGMA table_info(check_logs)').all<{ name: string }>()).results.map((column: { name: string }) => column.name)).toContain('provider');
    expect(parseVehicleSourceSetting((await db.prepare('SELECT provider, version, updated_by, updated_at FROM vehicle_source_settings').first()))).toMatchObject({ provider: 'BPAD', version: 1, updated_by: null });
  });
  it('schema CAS: next version must be max+1 by an active admin with a different provider; rows are immutable', async () => {
    await sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(2,'POTENSI_NTT',?,unixepoch())", ADMIN);
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(2,'BPAD',?,unixepoch())", ADMIN)).rejects.toThrow('Vehicle source version conflict');
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(4,'BPAD',?,unixepoch())", ADMIN)).rejects.toThrow('Vehicle source version conflict');
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'POTENSI_NTT',?,unixepoch())", ADMIN)).rejects.toThrow('Vehicle source unchanged');
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'BPAD',?,unixepoch())", OFFICER)).rejects.toThrow('Active admin required');
    // The actor guard fires before the row CHECK; either way an actorless change is refused.
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'BPAD',NULL,unixepoch())")).rejects.toThrow(/Active admin required|CHECK constraint/);
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'NJKB',?,unixepoch())", ADMIN)).rejects.toThrow('CHECK constraint');
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'BPAD',?,0)", ADMIN)).rejects.toThrow('Vehicle source clock regression');
    await sql("UPDATE users SET is_active=0 WHERE id=?", OTHER_ADMIN);
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(3,'BPAD',?,unixepoch())", OTHER_ADMIN)).rejects.toThrow('Active admin required');
    for (const set of ["provider='BPAD'", 'version=version', 'updated_at=updated_at+1', 'updated_by=NULL']) await expect(sql(`UPDATE vehicle_source_settings SET ${set} WHERE version=2`)).rejects.toThrow('Vehicle source setting is immutable');
    await expect(sql('DELETE FROM users WHERE id=?', ADMIN)).rejects.toThrow('FOREIGN KEY');
    expect(await current()).toEqual([{ version: 2, provider: 'POTENSI_NTT', updated_by: ADMIN }, { version: 1, provider: 'BPAD', updated_by: null }]);
    await expect(sql("INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source,provider) VALUES('bad','raid-officer',?,'bad','DH1ZZ','NOT_FOUND','LIVE','NJKB')", OFFICER)).rejects.toThrow('CHECK constraint');
  });
  it('populated upgrade from 0004 preserves history and users, leaves legacy provider NULL and seeds BPAD', async () => {
    const baseline = await startMigratedD1(undefined, '0004_check_vehicle.sql');
    try {
      await baseline.db.batch([
        baseline.db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('u','synthetic.user','unused','OFFICER')"),
        baseline.db.prepare("INSERT INTO locations(id,name) VALUES('l','Synthetic location')"),
        baseline.db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane,status,started_at,closed_at) VALUES('r','u','l','A','CLOSED',100,200)"),
        baseline.db.prepare("INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,tax_status,stnk_status,source,checked_at,vehicle_brand) VALUES('c1','r','u','k1','DH1ZZ','FOUND','ACTIVE','UNKNOWN','CACHE',150,'Brand'),('c2','r','u','k2','DH2ZZ','NOT_FOUND',NULL,NULL,'LIVE',160,NULL)"),
      ]);
      const before = (await baseline.db.prepare('SELECT * FROM check_logs ORDER BY id').all()).results as Record<string, unknown>[];
      expect(before[0]).not.toHaveProperty('provider');
      await expect(baseline.db.prepare('SELECT 1 FROM vehicle_source_settings').first()).rejects.toThrow();
      await applyTestMigrations(baseline.db, undefined, '0004_check_vehicle.sql');
      const after = (await baseline.db.prepare('SELECT * FROM check_logs ORDER BY id').all()).results as Record<string, unknown>[];
      expect(after.map(({ provider, ...rest }) => { expect(provider).toBeNull(); return rest; })).toEqual(before);
      expect(after[0].source).toBe('CACHE');
      expect((await baseline.db.prepare('SELECT version, provider, updated_by FROM vehicle_source_settings').all()).results).toEqual([{ version: 1, provider: 'BPAD', updated_by: null }]);
      expect((await baseline.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      await expect(baseline.db.prepare("UPDATE check_logs SET provider='BPAD'").run()).rejects.toThrow('Check log is immutable');
    } finally { await baseline.mf.dispose(); }
  });
  it('migration file is the fifth, append-only forward migration', async () => {
    const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
    expect(names).toEqual(['0001_foundation.sql', '0002_history.sql', '0003_admin.sql', '0004_check_vehicle.sql', '0005_vehicle_source.sql']);
    const sqlText = await readFile(new URL('../migrations/0005_vehicle_source.sql', import.meta.url), 'utf8');
    expect(sqlText).not.toMatch(/DROP TABLE|DELETE FROM check_logs|UPDATE check_logs/);
  });
});

describe('admin vehicle-source API', () => {
  it('GET returns the seed setting with credential presence as a boolean only', async () => {
    const response = await request('/api/admin/vehicle-source'); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ setting: { provider: 'BPAD', version: 1, updated_at: expect.any(Number), updated_by: null }, potensi_credentials_configured: false });
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    const configured = await request('/api/admin/vehicle-source');
    const body = await configured.text();
    expect(JSON.parse(body)).toMatchObject({ potensi_credentials_configured: true });
    expect(body).not.toMatch(/synthetic-id|synthetic-secret/);
  });
  it.each([['officer', 403, 'AUTHORIZATION_ERROR'], ['none', 401, 'AUTHENTICATION_ERROR']])('%s is rejected on GET and PUT without touching the setting', async (who, status, code) => {
    await error(await request('/api/admin/vehicle-source', { who }), status, code);
    await error(await put({ provider: 'POTENSI_NTT', expected_version: 1 }, who), status, code);
    expect(await current()).toHaveLength(1);
  });
  it('rejects query parameters, CSRF failures, non-JSON and non-allowlisted bodies', async () => {
    await error(await request('/api/admin/vehicle-source?limit=1'), 400, 'INVALID_INPUT');
    await error(await request('/api/admin/vehicle-source', { method: 'PUT', body: { provider: 'POTENSI_NTT', expected_version: 1 }, headers: { Origin: 'https://evil.test' } }), 403, 'CSRF_REJECTED');
    await error(await request('/api/admin/vehicle-source', { method: 'PUT', body: { provider: 'POTENSI_NTT', expected_version: 1 }, headers: { 'Content-Type': 'text/plain' } }), 403, 'CSRF_REJECTED');
    await error(await request('/api/admin/vehicle-source', { method: 'PUT', raw: '{' }), 400, 'INVALID_INPUT');
    for (const body of [{}, { provider: 'POTENSI_NTT' }, { expected_version: 1 }, { provider: 'POTENSI_NTT', expected_version: 1, updated_by: ADMIN }, { provider: 'NJKB', expected_version: 1 }, { provider: 'potensi_ntt', expected_version: 1 }, { provider: 'POTENSI_NTT', expected_version: '1' }, { provider: 'POTENSI_NTT', expected_version: 0 }, { provider: 'POTENSI_NTT', expected_version: 1.5 }, { provider: 'POTENSI_NTT', expected_version: 1, version: 1 }]) {
      await error(await put(body), 400, 'INVALID_INPUT');
    }
    await error(await request('/api/admin/vehicle-source?x=1', { method: 'PUT', body: { provider: 'POTENSI_NTT', expected_version: 1 } }), 400, 'INVALID_INPUT');
    expect(await current()).toHaveLength(1);
  });
  it('refuses Potensi while credentials are absent and keeps BPAD', async () => {
    await error(await put({ provider: 'POTENSI_NTT', expected_version: 1 }), 422, 'VEHICLE_SOURCE_CREDENTIALS_MISSING');
    env.POTENSI_ACCESS_CLIENT_ID = 'only-id';
    await error(await put({ provider: 'POTENSI_NTT', expected_version: 1 }), 422, 'VEHICLE_SOURCE_CREDENTIALS_MISSING');
    expect(await current()).toEqual([{ version: 1, provider: 'BPAD', updated_by: null }]);
  });
  it('switches with CAS, records actor atomically, logs a safe event and is idempotent for the same provider', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    const response = await put({ provider: 'POTENSI_NTT', expected_version: 1 }); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ setting: { provider: 'POTENSI_NTT', version: 2, updated_at: expect.any(Number), updated_by: { id: ADMIN, username: 'synthetic.admin' } }, potensi_credentials_configured: true });
    expect(await current()).toEqual([{ version: 2, provider: 'POTENSI_NTT', updated_by: ADMIN }, { version: 1, provider: 'BPAD', updated_by: null }]);
    expect(lines.map(line => JSON.parse(line))).toEqual([{ event: 'vehicle_source_changed', request_id: response.headers.get('x-request-id') }]);
    const noop = await put({ provider: 'POTENSI_NTT', expected_version: 2 }); expect(noop.status).toBe(200);
    expect(await noop.json()).toMatchObject({ setting: { provider: 'POTENSI_NTT', version: 2 } });
    expect(await current()).toHaveLength(2); expect(lines).toHaveLength(1);
    const back = await put({ provider: 'BPAD', expected_version: 2 }, 'other'); expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ setting: { provider: 'BPAD', version: 3, updated_by: { id: OTHER_ADMIN, username: 'synthetic.other' } } });
  });
  it('two admins racing from the same version: one 200 and one 409 conflict, never an overwrite', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    const first = await put({ provider: 'POTENSI_NTT', expected_version: 1 }); expect(first.status).toBe(200);
    await error(await put({ provider: 'BPAD', expected_version: 1 }, 'other'), 409, 'VEHICLE_SOURCE_CONFLICT');
    await error(await put({ provider: 'BPAD', expected_version: 1 }), 409, 'VEHICLE_SOURCE_CONFLICT');
    await error(await put({ provider: 'POTENSI_NTT', expected_version: 1 }, 'other'), 409, 'VEHICLE_SOURCE_CONFLICT');
    await error(await put({ provider: 'BPAD', expected_version: 5 }, 'other'), 409, 'VEHICLE_SOURCE_CONFLICT');
    expect(await current()).toEqual([{ version: 2, provider: 'POTENSI_NTT', updated_by: ADMIN }, { version: 1, provider: 'BPAD', updated_by: null }]);
    // Concurrent writers: both pass the preflight read, only one INSERT can win.
    await clearVehicleSourceChanges(db);
    const results = await Promise.all([put({ provider: 'POTENSI_NTT', expected_version: 1 }), put({ provider: 'POTENSI_NTT', expected_version: 1 }, 'other')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await current()).toHaveLength(2);
  });
  it('actor deactivated or revoked between preflight and write cannot record a change', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    // Batch 1 is the preflight read; the actor is deactivated just before batch 2 (the guarded write).
    const real = db as unknown as D1Database; let batches = 0;
    env.DB = { prepare: (query: string) => real.prepare(query), batch: async (statements: D1PreparedStatement[]) => {
      if (++batches === 2) await sql('UPDATE users SET is_active=0 WHERE id=?', ADMIN);
      return real.batch(statements);
    } } as unknown as D1Database;
    const response = await put({ provider: 'POTENSI_NTT', expected_version: 1 });
    expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    env.DB = db;
    expect(await current()).toEqual([{ version: 1, provider: 'BPAD', updated_by: null }]);
    expect(lines.map(line => JSON.parse(line))).toEqual([{ event: 'request_failed', request_id: response.headers.get('x-request-id'), code: 'AUTHENTICATION_ERROR' }]);
  });
  it('fails closed with 503 when the setting rows are missing instead of resetting silently', async () => {
    // Hide every setting row from the application's reads (a missing/emptied table), without mutating the seed.
    const real = db as unknown as D1Database;
    env.DB = { prepare(query: string) { return real.prepare(query.replaceAll('FROM vehicle_source_settings v', 'FROM (SELECT * FROM vehicle_source_settings WHERE 0) v')); }, batch: (statements: D1PreparedStatement[]) => real.batch(statements) } as unknown as D1Database;
    await error(await request('/api/admin/vehicle-source'), 503, 'VEHICLE_SOURCE_UNAVAILABLE');
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    await error(await put({ provider: 'POTENSI_NTT', expected_version: 1 }), 503, 'VEHICLE_SOURCE_UNAVAILABLE');
    env.DB = db;
    expect(await current()).toEqual([{ version: 1, provider: 'BPAD', updated_by: null }]);
  });
  it('the setting history is append-only: deleting the newest row cannot silently re-activate an older provider', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    expect((await put({ provider: 'POTENSI_NTT', expected_version: 1 })).status).toBe(200);
    for (const query of ['DELETE FROM vehicle_source_settings WHERE version = 2', 'DELETE FROM vehicle_source_settings WHERE version = 1', 'DELETE FROM vehicle_source_settings']) {
      await expect(sql(query)).rejects.toThrow('Vehicle source history is append-only');
    }
    // A seed re-insert can never pass the CAS guard either.
    await expect(sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(1,'BPAD',NULL,unixepoch())")).rejects.toThrow();
    expect(await current()).toEqual([{ version: 2, provider: 'POTENSI_NTT', updated_by: ADMIN }, { version: 1, provider: 'BPAD', updated_by: null }]);
    expect(await (await lookup('officer')).json()).toMatchObject({ provider: 'POTENSI_NTT' });
  });
});

describe('global provider on lookups', () => {
  it('applies the new source to every user on the next lookup, and only the first snapshot per raid/plate is recorded with its provider', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    expect(await (await lookup('officer')).json()).toMatchObject({ provider: 'BPAD', snapshot_synced_at: null, vehicle: { owner_name: 'Owner Live' } });
    expect((await put({ provider: 'POTENSI_NTT', expected_version: 1 })).status).toBe(200);
    for (const who of ['officer', 'second']) expect(await (await lookup(who)).json()).toMatchObject({ provider: 'POTENSI_NTT', source: 'LIVE', snapshot_synced_at: '2026-10-18T00:00:00.000Z', vehicle: { owner_name: null } });
    expect(bpad).toHaveBeenCalledTimes(1); expect(potensi).toHaveBeenCalledTimes(2);
    await Promise.all(tasks);
    const rows = (await db.prepare('SELECT raid_session_id, provider, source FROM check_logs ORDER BY raid_session_id').all()).results;
    expect(rows).toEqual([{ raid_session_id: 'raid-officer', provider: 'BPAD', source: 'LIVE' }, { raid_session_id: 'raid-second', provider: 'POTENSI_NTT', source: 'LIVE' }]);
  });
  it('an in-flight lookup finishes with the provider captured at its start', async () => {
    env.POTENSI_ACCESS_CLIENT_ID = 'synthetic-id'; env.POTENSI_ACCESS_CLIENT_SECRET = 'synthetic-secret-value';
    const started = deferred<void>(); const release = deferred<void>();
    bpad.mockImplementation(async nopol => { started.resolve(); await release.promise; return found(nopol, 'BPAD'); });
    const pending = lookup('officer'); await started.promise;
    expect((await put({ provider: 'POTENSI_NTT', expected_version: 1 })).status).toBe(200);
    release.resolve();
    const response = await pending; expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'BPAD', snapshot_synced_at: null });
    expect(potensi).not.toHaveBeenCalled();
    expect(await (await lookup('officer')).json()).toMatchObject({ provider: 'POTENSI_NTT' });
    await Promise.all(tasks);
    expect(await db.prepare('SELECT provider FROM check_logs').first('provider')).toBe('BPAD');
  });
  it('Potensi selected without runtime credentials fails closed with 503 and never falls back to BPAD', async () => {
    // Production resolution path: only BPAD is injected; Potensi must be built from the runtime secrets.
    app = createApp(createSafeLogger(line => lines.push(line)), { sources: { BPAD: { lookup: bpad } }, clock: () => NOW, fetcher: async () => { await potensi('outbound'); throw new Error('outbound forbidden'); } });
    await sql("INSERT INTO vehicle_source_settings(version,provider,updated_by,updated_at) VALUES(2,'POTENSI_NTT',?,unixepoch())", ADMIN);
    await error(await lookup('officer'), 503, 'VEHICLE_SOURCE_UNAVAILABLE');
    expect(bpad).not.toHaveBeenCalled(); expect(potensi).not.toHaveBeenCalled();
    await Promise.all(tasks);
    expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(0);
  });
  it('an unknown provider value in the setting fails closed', async () => {
    const real = db as unknown as D1Database;
    env.DB = { prepare(query: string) { return real.prepare(query.replace('(SELECT provider FROM vehicle_source_settings ORDER BY version DESC LIMIT 1) AS provider', "'NJKB' AS provider")); } } as D1Database;
    await error(await lookup('officer'), 503, 'VEHICLE_SOURCE_UNAVAILABLE');
    expect(bpad).not.toHaveBeenCalled();
  });
  it('upstream errors from either provider never become NOT_FOUND or history', async () => {
    const { AppError } = await import('../shared/errors');
    for (const code of ['UPSTREAM_FORBIDDEN', 'UPSTREAM_BUSY', 'UPSTREAM_NETWORK', 'UPSTREAM_MALFORMED', 'TIMEOUT'] as const) {
      bpad.mockImplementation(async () => { throw new AppError(code); });
      const response = await lookup('officer');
      expect(response.status).toBe(code === 'TIMEOUT' ? 504 : code === 'UPSTREAM_BUSY' ? 503 : 502);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    await Promise.all(tasks);
    expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(0);
  });
});

describe('no cache anywhere', () => {
  it('worker sources never reference the KV binding, Cache API or cache events', async () => {
    const directory = new URL('../worker/', import.meta.url);
    const files = ['index.ts', 'lookups.ts', 'vehicle-source.ts', 'admin.ts', 'history.ts', 'logger.ts', 'dev-index.ts', 'vehicle/bpad.ts', 'vehicle/potensi.ts', 'vehicle/source.ts', 'vehicle/transport.ts', 'vehicle/contracts.ts', 'vehicle/development.ts', 'vehicle/mock.ts'];
    for (const file of files) {
      const text = await readFile(new URL(file, directory), 'utf8');
      expect(text, file).not.toMatch(/VEHICLE_CACHE|caches\.(open|match|default)|KVNamespace|expirationTtl|cache_read_failed|cache_write_failed|cache_rejected|vehicle\/cache/);
    }
    await expect(readFile(new URL('vehicle/cache.ts', directory), 'utf8')).rejects.toThrow();
    const client = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
    expect(client).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\./);
    expect(client).toContain("cache: 'no-store'");
  });
});
