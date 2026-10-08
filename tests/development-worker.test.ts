import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEVELOPMENT_CONFIG, DEVELOPMENT_LOCATION, DEVELOPMENT_USERS, buildDevelopmentSeedStatements } from '../scripts/development';
import { PROJECT_ROOT } from '../scripts/lib';
import { hashPassword, verifyPassword } from '../shared/password';
import { vehicleCacheKey } from '../worker/vehicle/cache';
import { applyTestMigrations, resetTestD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'http://127.0.0.1:8787';
let outdir: string | undefined, mf: Miniflare | undefined, denied: Miniflare | undefined, db: TestD1;
let outbound = 0, assetCalls = 0;
const post = (path: string, body: unknown, token?: string) => mf!.dispatchFetch(`${ORIGIN}${path}`, {method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',...(token ? {Cookie:`__Host-rs_session=${token}`} : {})},body:JSON.stringify(body)});
const get = (path: string, token: string) => mf!.dispatchFetch(`${ORIGIN}${path}`,{headers:{Cookie:`__Host-rs_session=${token}`}});
const tokenFrom = (response: {headers:{get(name:string):string | null}}) => {
  const token = /^__Host-rs_session=([A-Za-z0-9_-]{43});/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  expect(token).toBeDefined(); return token!;
};
async function bundle(config?: string): Promise<string> {
  const directory = join(outdir!,config ? 'development' : 'production');
  const result = spawnSync(process.execPath,[join(PROJECT_ROOT,'node_modules','wrangler','bin','wrangler.js'),'deploy','--dry-run','--outdir',directory,...(config ? ['--config',config] : [])],{cwd:PROJECT_ROOT,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true'}});
  if (result.status !== 0) throw new Error('Local bundle failed');
  return join(directory,config ? 'dev-index.js' : 'index.js');
}
beforeAll(async () => {
  const parent = join(PROJECT_ROOT,'.wrangler','test-bundles'); await mkdir(parent,{recursive:true}); outdir=await mkdtemp(join(parent,'phase8-'));
  const scriptPath = await bundle(DEVELOPMENT_CONFIG);
  const options = { modules:true,modulesRoot:PROJECT_ROOT,scriptPath,compatibilityDate:'2026-10-07',d1Databases:['DB'],kvNamespaces:['VEHICLE_CACHE'],
    bindings:{APP_ENV:'development',PASSWORD_PBKDF2_ITERATIONS:'100000',SESSION_TTL_SECONDS:'43200',RETENTION_POLICY:'UNSET'},
    serviceBindings:{ASSETS:()=>{assetCalls++; return new RuntimeResponse('Synthetic asset');}},
    outboundService:()=>{outbound++; return new RuntimeResponse('Outbound prohibited',{status:503});} };
  mf = new Miniflare(convertV4MiniflareOptions(options)); db=await mf.getD1Database('DB'); await applyTestMigrations(db);
  const hashes=await Promise.all(DEVELOPMENT_USERS.map(()=>hashPassword('password',100000)));
  await db.batch(buildDevelopmentSeedStatements(hashes).map(sql=>db.prepare(sql)));
  denied = new Miniflare(convertV4MiniflareOptions({...options,bindings:{...options.bindings,APP_ENV:'production'}}));
},180000);
afterAll(async () => { try { await denied?.dispose(); await mf?.dispose(); } finally { if(outdir) await rm(outdir,{recursive:true,force:true}); } });

it('bundled development entry blocks remote API/assets and invalid marker before application access',async()=>{
  const previous=assetCalls;
  for(const path of ['/api/health','/login','/assets/app.js']) {
    const remote=await mf!.dispatchFetch(`https://accidental.workers.dev${path}`,{headers:{Host:'localhost','X-Forwarded-Host':'localhost'}});
    expect(remote.status).toBe(503); expect(await remote.json()).toMatchObject({error:{code:'ROUTE_NOT_FOUND'}}); expect(remote.headers.get('cache-control')).toBe('no-store');
    expect((await denied!.dispatchFetch(`${ORIGIN}${path}`)).status).toBe(503);
  }
  expect(assetCalls).toBe(previous); expect(outbound).toBe(0);
  expect((await mf!.dispatchFetch(`${ORIGIN}/login`)).status).toBe(200); expect(assetCalls).toBe(previous+1);
});
it('real login/raid/cache/history/admin preserve existing rules with four simulated outcomes',async()=>{
  const officerLogin=await post('/api/auth/login',{username:DEVELOPMENT_USERS[1].username,password:'password'}); expect(officerLogin.status).toBe(200);
  const officer=tokenFrom(officerLogin); expect(await officerLogin.json()).toMatchObject({user:{id:DEVELOPMENT_USERS[1].id,role:'OFFICER'}});
  expect((await post('/api/auth/login',{username:DEVELOPMENT_USERS[1].username,password:'password'})).status).toBe(409);
  const adminLogin=await post('/api/auth/login',{username:DEVELOPMENT_USERS[0].username,password:'password'}); expect(adminLogin.status).toBe(200); const admin=tokenFrom(adminLogin);
  expect((await post('/api/auth/login',{username:DEVELOPMENT_USERS[0].username,password:'password'})).status).toBe(200);
  const locations=await get('/api/locations',officer); expect(await locations.json()).toMatchObject({locations:[DEVELOPMENT_LOCATION]});
  const started=await post('/api/raid-sessions',{location_id:DEVELOPMENT_LOCATION.id,lane:'Jalur UAT'},officer); expect(started.status).toBe(201); const raid=await started.json() as {id:string};
  for(const [nopol,tax,stnk] of [['DH1823HJ','ACTIVE','ACTIVE'],['DH7112DP','EXPIRED','UNKNOWN'],['DH5871GD','EXPIRED','EXPIRED'],['DH6162RK',null,null]]) {
    const response=await post('/api/vehicle-lookups',{nopol},officer); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(tax ? {outcome:'FOUND',source:'LIVE',vehicle:{nopol,tax_status:tax,stnk_status:stnk}} : {outcome:'NOT_FOUND'});
  }
  const first=await db.prepare('SELECT * FROM check_logs WHERE raid_session_id=? AND nopol=?').bind(raid.id,'DH1823HJ').first();
  const repeat=await post('/api/vehicle-lookups',{nopol:'DH1823HJ'},officer); expect(await repeat.json()).toMatchObject({source:'CACHE'});
  expect(await db.prepare('SELECT * FROM check_logs WHERE raid_session_id=? AND nopol=?').bind(raid.id,'DH1823HJ').first()).toEqual(first);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM check_logs').first('n')).toBe(4);
  const summary=await get(`/api/raid-sessions/${raid.id}/summary`,officer); expect(await summary.json()).toMatchObject({summary:{total_checks:4,found:3,not_found:1,tax_active:1,tax_expired:2,tax_unknown:0}});
  expect((await get('/api/admin/users',officer)).status).toBe(403); expect((await get('/api/admin/users',admin)).status).toBe(200);
  const other=await post('/api/raid-sessions',{location_id:DEVELOPMENT_LOCATION.id,lane:'ADMIN UAT'},admin); const otherRaid=await other.json() as {id:string};
  expect((await get(`/api/raid-sessions/${otherRaid.id}/checks`,officer)).status).toBe(404);
  const {VEHICLE_CACHE:kv}=await mf!.getBindings<Pick<Env,'VEHICLE_CACHE'>>(); const cache=await kv.get(await vehicleCacheKey('DH1823HJ'),'json') as Record<string,unknown>;
  expect(Object.keys(cache).sort()).toEqual(['brand','color','nopol','owner_name','provider_fetched_at','stnk_due_date','tax_due_date','type']);
  expect(await kv.get(await vehicleCacheKey('DH6162RK'))).toBeNull(); expect(outbound).toBe(0);
},60000);
it('repeated seed preserves modified credentials/role/activity and existing different identity',async()=>{
  const replacement=await hashPassword('Synthetic replacement',100000);
  await db.prepare("UPDATE users SET password_hash=?,role='OFFICER',is_active=0 WHERE id=?").bind(replacement,DEVELOPMENT_USERS[1].id).run();
  await db.prepare('UPDATE locations SET is_active=0 WHERE id=?').bind(DEVELOPMENT_LOCATION.id).run();
  const before=await db.prepare('SELECT * FROM users ORDER BY id').all();
  await db.batch(buildDevelopmentSeedStatements(await Promise.all(DEVELOPMENT_USERS.map(()=>hashPassword('password',100000)))).map(sql=>db.prepare(sql)));
  expect((await db.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before.results);
  expect(await db.prepare('SELECT is_active FROM locations WHERE id=?').bind(DEVELOPMENT_LOCATION.id).first('is_active')).toBe(0);
  expect((await verifyPassword('Synthetic replacement',replacement)).ok).toBe(true);
  expect((await verifyPassword('password',replacement)).ok).toBe(false);
  const hashes=await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(DEVELOPMENT_USERS[0].id).first<string>('password_hash'); expect((await verifyPassword('password',hashes!)).ok).toBe(true);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},60000);
it('preserves existing usernames and locations with different UUIDs, failing closed on ID collision',async()=>{
  await resetTestD1(db);
  const existing='82000000-0000-4000-8000-000000000001';
  const hash=await hashPassword('Existing synthetic password',100000);
  await db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES(?,?,?,'OFFICER',0)").bind(existing,DEVELOPMENT_USERS[0].username,hash).run();
  await db.prepare("INSERT INTO locations(id,name,is_active) VALUES('82000000-0000-4000-8000-000000000003',?,0)").bind(DEVELOPMENT_LOCATION.name).run();
  const seed=buildDevelopmentSeedStatements(await Promise.all(DEVELOPMENT_USERS.map(()=>hashPassword('password',100000))));
  await db.batch(seed.map(sql=>db.prepare(sql)));
  expect(await db.prepare('SELECT id,password_hash,role,is_active FROM users WHERE username=?').bind(DEVELOPMENT_USERS[0].username).first()).toEqual({id:existing,password_hash:hash,role:'OFFICER',is_active:0});
  expect(await db.prepare('SELECT COUNT(*) AS n FROM locations').first('n')).toBe(1);
  await resetTestD1(db);
  await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.collision',?,'OFFICER')").bind(DEVELOPMENT_USERS[0].id,hash).run();
  await expect(db.batch(seed.map(sql=>db.prepare(sql)))).rejects.toThrow();
  expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1);
});
it('actual production bundle excludes development source, scenarios, credentials and fixture identities',async()=>{
  const production=await readFile(await bundle(),'utf8');
  for(const forbidden of ['DevVehicleSource','developmentDueDate','DH1823HJ','DH7112DP','DH5871GD','DH6162RK','elwinbessiesura','yusuf.adoe',...DEVELOPMENT_USERS.map(user=>user.id),DEVELOPMENT_LOCATION.id,'Pemilik Sintetik UAT']) expect(production).not.toContain(forbidden);
  expect(production).toContain('dash.bpad.nttprov.go.id');
},180000);
