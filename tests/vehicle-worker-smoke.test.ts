import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response as RuntimeResponse, type Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { startMigratedD1, type TestD1 } from './helpers/miniflare';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://app.test';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
let outdir: string;
let mf: Miniflare;
let db: TestD1;
let token: string;
let adminToken: string;
let providerStatus = 200;
const outboundRequests: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
const cookie = (value: string) => ({ Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `__Host-rs_session=${value}` });
const post = (body: unknown, who = token) => mf.dispatchFetch(`${ORIGIN}/api/vehicle-lookups`, { method: 'POST', body: JSON.stringify(body), headers: cookie(who) });
const potensiFixture = () => ({
  status: 'vehicle_found', vehicle_status: 'found', njkb_status: 'not_found', nopol: 'DH1234ZZ',
  vehicle: { category: 'SEPEDA MOTOR', brand: 'Brand Snapshot', type: null, color: 'Color Snapshot', chassis_number: 'FORBIDDEN_SENTINEL', engine_number: 'FORBIDDEN_SENTINEL' },
  registration: { stnk_valid_until: '2026-01-06', plate_color: 'PUTIH' },
  tax: { notice_valid_until: '2024-01-06', previous_pkb_date: null, kohir: null },
  owner: { name: 'Owner Snapshot', identity_number: 'FORBIDDEN_SENTINEL', address: 'FORBIDDEN_SENTINEL' },
  potensi: { synced_at: '2026-10-18T00:00:00.000Z', amounts: { total: 'FORBIDDEN_SENTINEL' } },
});

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), 'razia-lookup-bundle-'));
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--dry-run', '--outdir', outdir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' } });
  if (result.status !== 0) throw new Error(`wrangler dry-run failed: ${result.stderr}`);
  // Intercept ALL outbound fetches: this test cannot contact live BPAD or Potensi, even on a wrong URL.
  ({ mf, db } = await startMigratedD1({ modules: true, modulesRoot: outdir, scriptPath: join(outdir, 'index.js'), kvNamespaces: ['VEHICLE_CACHE'],
    bindings: { PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET', POTENSI_ACCESS_CLIENT_ID: 'synthetic-client-id.access', POTENSI_ACCESS_CLIENT_SECRET: 'synthetic-client-secret-value' },
    outboundService: async request => {
      outboundRequests.push({ url: request.url, method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) });
      if (providerStatus !== 200) return new RuntimeResponse('FORBIDDEN_SENTINEL', { status: providerStatus });
      if (request.url.startsWith('https://api.uptdpenda-kupang.web.id/')) return RuntimeResponse.json(potensiFixture());
      const today = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
      return RuntimeResponse.json({ kode: '1', status: 'success', NOPOL: 'DH1234ZZ', NamaPemilik: 'Synthetic Owner', Merk: 'Brand', Type: 'Type', Warna: 'Color', SD_NOTICE: today, SD_STNK: null, NIK: 'FORBIDDEN_SENTINEL', Alamat: 'FORBIDDEN_SENTINEL' });
    } }));
  token = generateSessionToken(); adminToken = generateSessionToken();
  await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('user','synthetic.user','unused','OFFICER'),(?,'synthetic.admin','unused','ADMIN')").bind(ADMIN_ID).run();
  await db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES('session','user',?,unixepoch()+43200),('admin-session',?,?,unixepoch()+43200)").bind(await hashSessionToken(token), ADMIN_ID, await hashSessionToken(adminToken)).run();
  await db.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')").run();
  await db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid','user','location','A')").run();
}, 180000);
afterAll(async () => {
  try { await mf?.dispose(); }
  finally { if (outdir) await rm(outdir, { recursive: true, force: true }); }
});

it('production bundle: BPAD default, every lookup upstream, zero KV, one history snapshot, then a global switch to Potensi with Access headers', async () => {
  const live = await post({ nopol: 'dh 1234 zz' }); expect({ status: live.status, calls: outboundRequests.length }).toEqual({ status: 200, calls: 1 });
  expect(outboundRequests[0]).toMatchObject({ url: 'https://dash.bpad.nttprov.go.id/pajak/webdtd/pendataan/core/php/getnopol.php', method: 'POST', body: '{"nopol":"DH1234ZZ"}' });
  expect(outboundRequests[0].headers['cf-access-client-id']).toBeUndefined();
  const body = await live.json() as { source: string; provider: string; fetched_at: string; snapshot_synced_at: unknown; evaluated_on: string; request_id: string; vehicle: Record<string, unknown> };
  expect(body).toMatchObject({ source: 'LIVE', provider: 'BPAD', snapshot_synced_at: null }); expect(body.request_id).toBe(live.headers.get('x-request-id'));
  expect(live.headers.get('cache-control')).toBe('no-store');
  expect(body.evaluated_on).toBe(new Date(Date.now()+8*3600000).toISOString().slice(0,10));
  expect(body.vehicle).toMatchObject({ tax_status: 'EXPIRED', stnk_status: 'UNKNOWN' });
  expect(Object.keys(body.vehicle).sort()).toEqual(['brand', 'color', 'nopol', 'owner_name', 'stnk_due_date', 'stnk_status', 'tax_due_date', 'tax_status', 'type']);
  expect(JSON.stringify(body)).not.toContain('FORBIDDEN_SENTINEL');
  // dispatchFetch has completed its waitUntil work before these reads.
  const kv = await mf.getKVNamespace('VEHICLE_CACHE') as unknown as KVNamespace;
  expect((await kv.list()).keys).toEqual([]);
  const snapshot = await db.prepare('SELECT * FROM check_logs').first();
  expect(snapshot).toMatchObject({ raid_session_id: 'raid', user_id: 'user', idempotency_key: body.request_id, nopol: 'DH1234ZZ', outcome: 'FOUND', tax_status: 'EXPIRED', stnk_status: 'UNKNOWN', source: 'LIVE', provider: 'BPAD' });
  expect(Object.keys(snapshot!).sort()).toEqual(['checked_at', 'id', 'idempotency_key', 'nopol', 'outcome', 'provider', 'raid_session_id', 'source', 'stnk_status', 'tax_status', 'user_id', 'vehicle_brand', 'vehicle_color', 'vehicle_type']);
  // Same plate again: a second upstream call, no cache, same single snapshot.
  const repeat = await post({ nopol: 'DH1234ZZ' }); expect(await repeat.json()).toMatchObject({ source: 'LIVE', provider: 'BPAD' }); expect(outboundRequests).toHaveLength(2);
  expect((await kv.list()).keys).toEqual([]);
  expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(1);
  providerStatus = 502;
  const failure = await post({ nopol: 'DH1234ZZ' }); expect(failure.status).toBe(502); expect(await failure.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } });
  providerStatus = 200;
  expect(await db.prepare('SELECT * FROM check_logs').first()).toEqual(snapshot);

  // Admin switches the global source; the officer's next lookup goes to Potensi with the Access service token headers.
  const before = await mf.dispatchFetch(`${ORIGIN}/api/admin/vehicle-source`, { headers: { Cookie: `__Host-rs_session=${adminToken}` } });
  expect(await before.json()).toMatchObject({ setting: { provider: 'BPAD', version: 1 }, potensi_credentials_configured: true });
  const switched = await mf.dispatchFetch(`${ORIGIN}/api/admin/vehicle-source`, { method: 'PUT', headers: cookie(adminToken), body: JSON.stringify({ provider: 'POTENSI_NTT', expected_version: 1 }) });
  expect(switched.status).toBe(200);
  expect(await switched.json()).toMatchObject({ setting: { provider: 'POTENSI_NTT', version: 2, updated_by: { id: ADMIN_ID, username: 'synthetic.admin' } } });
  const potensi = await post({ nopol: 'DH1234ZZ' }); expect(potensi.status).toBe(200);
  const request = outboundRequests.at(-1)!;
  expect(request).toMatchObject({ url: 'https://api.uptdpenda-kupang.web.id/api/v1/vehicle/DH1234ZZ', method: 'GET', body: '' });
  expect(request.headers['cf-access-client-id']).toBe('synthetic-client-id.access');
  expect(request.headers['cf-access-client-secret']).toBe('synthetic-client-secret-value');
  const snapshotBody = await potensi.json() as Record<string, unknown>;
  expect(snapshotBody).toMatchObject({ outcome: 'FOUND', source: 'LIVE', provider: 'POTENSI_NTT', snapshot_synced_at: '2026-10-18T00:00:00.000Z', vehicle: { owner_name: 'Owner Snapshot', brand: 'Brand Snapshot', type: null, color: 'Color Snapshot', tax_due_date: '2024-01-06', stnk_due_date: '2026-01-06', tax_status: 'EXPIRED', stnk_status: 'EXPIRED' } });
  expect(JSON.stringify(snapshotBody)).not.toMatch(/FORBIDDEN_SENTINEL|synthetic-client/);
  expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(1);
  expect(await db.prepare('SELECT * FROM check_logs').first()).toEqual(snapshot);
  expect((await kv.list()).keys).toEqual([]);
}, 60000);
