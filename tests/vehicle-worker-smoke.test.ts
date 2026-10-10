import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response as RuntimeResponse, type Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { vehicleCacheKey } from '../worker/vehicle/cache';
import { startMigratedD1, type TestD1 } from './helpers/miniflare';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://app.test';
let outdir: string;
let mf: Miniflare;
let db: TestD1;
let token: string;
let providerCalls = 0;
let providerStatus = 200;
const outboundRequests: { url: string; method: string; body: string }[] = [];
const post = (body: unknown) => mf.dispatchFetch(`${ORIGIN}/api/vehicle-lookups`, { method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `__Host-rs_session=${token}` } });

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), 'razia-lookup-bundle-'));
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--dry-run', '--outdir', outdir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' } });
  if (result.status !== 0) throw new Error(`wrangler dry-run failed: ${result.stderr}`);
  // Intercept ALL outbound fetches: this test cannot contact live BPAD, even on a wrong URL.
  ({ mf, db } = await startMigratedD1({ modules: true, modulesRoot: outdir, scriptPath: join(outdir, 'index.js'), kvNamespaces: ['VEHICLE_CACHE'], bindings: { PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' }, outboundService: async request => {
    providerCalls++;
    outboundRequests.push({ url: request.url, method: request.method, body: await request.text() });
    if (providerStatus !== 200) return new RuntimeResponse('FORBIDDEN_SENTINEL', { status: providerStatus });
    const today = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    return RuntimeResponse.json({ kode: '1', status: 'success', NOPOL: 'DH1234ZZ', NamaPemilik: 'Synthetic Owner', Merk: 'Brand', Type: 'Type', Warna: 'Color', SD_NOTICE: today, SD_STNK: null, NIK: 'FORBIDDEN_SENTINEL', Alamat: 'FORBIDDEN_SENTINEL' });
  } }));
  token = generateSessionToken();
  await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('user','synthetic.user','unused','OFFICER')").run();
  await db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES('session','user',?,unixepoch()+43200)").bind(await hashSessionToken(token)).run();
  await db.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')").run();
  await db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid','user','location','A')").run();
}, 180000);
afterAll(async () => {
  try { await mf?.dispose(); }
  finally { if (outdir) await rm(outdir, { recursive: true, force: true }); }
});

it('production registration uses BPAD adapter and actual KV with WITA/no-store/allowlist, not browser graph', async () => {
  const live = await post({ nopol: 'dh 1234 zz' }); expect({ status: live.status, calls: providerCalls, requests: outboundRequests }).toMatchObject({ status: 200, calls: 1 });
  expect(outboundRequests).toEqual([{ url: 'https://dash.bpad.nttprov.go.id/pajak/webdtd/pendataan/core/php/getnopol.php', method: 'POST', body: '{"nopol":"DH1234ZZ"}' }]);
  const body = await live.json() as { source: string; fetched_at: string; evaluated_on: string; request_id: string; vehicle: Record<string, unknown> };
  expect(body.source).toBe('LIVE'); expect(body.request_id).toBe(live.headers.get('x-request-id'));
  expect(live.headers.get('cache-control')).toBe('no-store');
  expect(body.evaluated_on).toBe(new Date(Date.now()+8*3600000).toISOString().slice(0,10));
  expect(body.vehicle).toMatchObject({ tax_status: 'EXPIRED', stnk_status: 'UNKNOWN' });
  expect(Object.keys(body.vehicle).sort()).toEqual(['brand', 'color', 'nopol', 'owner_name', 'stnk_due_date', 'stnk_status', 'tax_due_date', 'tax_status', 'type']);
  expect(JSON.stringify(body)).not.toContain('FORBIDDEN_SENTINEL');
  // dispatchFetch response has completed its waitUntil writes before this KV read.
  const kv = await mf.getKVNamespace('VEHICLE_CACHE') as unknown as KVNamespace;
  const stored = await kv.get(await vehicleCacheKey('DH1234ZZ'), 'json') as Record<string, unknown>;
  expect(stored).toMatchObject({ nopol: 'DH1234ZZ', provider_fetched_at: body.fetched_at });
  expect(Object.keys(stored).sort()).toEqual(['brand', 'color', 'nopol', 'owner_name', 'provider_fetched_at', 'stnk_due_date', 'tax_due_date', 'type']);
  const snapshot = await db.prepare('SELECT * FROM check_logs').first();
  expect(snapshot).toMatchObject({ raid_session_id: 'raid', user_id: 'user', idempotency_key: body.request_id, nopol: 'DH1234ZZ', outcome: 'FOUND', tax_status: 'EXPIRED', stnk_status: 'UNKNOWN', source: 'LIVE' });
  expect(Object.keys(snapshot!).sort()).toEqual(['checked_at', 'id', 'idempotency_key', 'nopol', 'outcome', 'raid_session_id', 'source', 'stnk_status', 'tax_status', 'user_id']);
  expect(snapshot!.checked_at).toBeGreaterThanOrEqual(Math.floor(Date.parse(body.fetched_at)/1000));
  expect(snapshot!.checked_at).toBeLessThanOrEqual(Math.floor(Date.now()/1000));
  const cached = await post({ nopol: 'DH1234ZZ' }); expect(await cached.json()).toMatchObject({ source: 'CACHE', fetched_at: body.fetched_at }); expect(providerCalls).toBe(1);
  await kv.delete(await vehicleCacheKey('DH1234ZZ')); providerStatus = 502;
  const failure = await post({ nopol: 'DH1234ZZ' }); expect(failure.status).toBe(502); expect(await failure.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } });
  expect(await kv.get(await vehicleCacheKey('DH1234ZZ'))).toBeNull();
  expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(1);
  expect(await db.prepare('SELECT * FROM check_logs').first()).toEqual(snapshot);
}, 60000);
