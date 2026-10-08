import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, parsePasswordHash, verifyPassword } from '../shared/password';
import { PROJECT_ROOT } from '../scripts/lib';
import { buildBootstrapSql, bootstrapAdmin, type SqlRunner } from '../scripts/production';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

// Synthetic local runtime evidence only. No live BPAD, production credentials or remote resource operations.
const ORIGIN='https://app.test';
const ADMIN='11111111-1111-4111-8111-111111111111';
const OFFICER='22222222-2222-4222-8222-222222222222';
const LEGACY='33333333-3333-4333-8333-333333333333';
const INACTIVE='44444444-4444-4444-8444-444444444444';
const CORRUPT='55555555-5555-4555-8555-555555555555';
const PASSWORD='Synthetic-runtime-ten';
const REPLACEMENT='Synthetic-runtime-replacement';
const CLEARED='__Host-rs_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';
let outdir:string|undefined,mf:Miniflare|undefined,db:TestD1,tenHash:string,legacyHash:string;
let outbound=0;
const post=(path:string,body:unknown,token?:string,origin=ORIGIN)=>mf!.dispatchFetch(`${ORIGIN}${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Cookie:`__Host-rs_session=${token}`}:{})},body:JSON.stringify(body)});
const me=(token:string)=>mf!.dispatchFetch(`${ORIGIN}/api/auth/me`,{headers:{Cookie:`__Host-rs_session=${token}`}});
const login=(username:string,password=PASSWORD,token?:string)=>post('/api/auth/login',{username,password},token);
function tokenOf(response: { headers: { get(name: string): string | null } }):string {
  const cookie=response.headers.get('set-cookie')??'';
  const match=/^__Host-rs_session=([A-Za-z0-9_-]{43}); Max-Age=(\d+); Path=\/; HttpOnly; Secure; SameSite=Strict$/.exec(cookie);
  if(!match) throw new Error('Missing hardened session cookie');
  expect(Number(match[2])).toBeGreaterThanOrEqual(43199); expect(Number(match[2])).toBeLessThanOrEqual(43200);
  return match[1];
}
async function loginToken(username:string,password=PASSWORD):Promise<string> {
  const response=await login(username,password); expect(response.status).toBe(200); return tokenOf(response);
}
async function assertHash(userId:string,password:string,count:number):Promise<string> {
  const stored=await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(userId).first<string>('password_hash');
  const parsed=parsePasswordHash(stored);
  // Boolean assertions avoid emitting synthetic passwords or hashes as test diagnostics.
  expect(Boolean(parsed&&parsed.iterations===count&&parsed.salt.byteLength===16&&parsed.hash.byteLength===32)).toBe(true);
  if(!parsed||!stored) throw new Error('Unexpected password encoding');
  const native=pbkdf2Sync(password,parsed.salt,count,32,'sha256');
  expect(native.equals(Buffer.from(parsed.hash))).toBe(true);
  expect((await verifyPassword(password,stored,10)).ok).toBe(true);
  expect((await verifyPassword('Synthetic-wrong',stored,10)).ok).toBe(false);
  return stored;
}
const execute:SqlRunner=async sql=>[await db.prepare(sql).all()];
beforeAll(async()=>{
  const parent=join(PROJECT_ROOT,'.wrangler','test-bundles'); await mkdir(parent,{recursive:true}); outdir=await mkdtemp(join(parent,'password-compatibility-'));
  const bundle=spawnSync(process.execPath,[join(PROJECT_ROOT,'node_modules','wrangler','bin','wrangler.js'),'deploy','--dry-run','--outdir',outdir],{cwd:PROJECT_ROOT,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true'}});
  if(bundle.status!==0) throw new Error('Local Worker bundling failed');
  ({mf,db}=await startMigratedD1({modules:true,modulesRoot:PROJECT_ROOT,scriptPath:join(outdir,'index.js'),bindings:{PASSWORD_PBKDF2_ITERATIONS:'10',SESSION_TTL_SECONDS:'43200',RETENTION_POLICY:'UNSET'},outboundService:()=>{outbound++;return new Response('Outbound disabled in synthetic password compatibility tests',{status:503});}}));
  tenHash=await hashPassword(PASSWORD,10); legacyHash=await hashPassword(PASSWORD,100000);
},180000);
beforeEach(async()=>{
  await resetTestD1(db); outbound=0;
  const sql=buildBootstrapSql(ADMIN,crypto.randomUUID(),'synthetic.admin',tenHash,10);
  await bootstrapAdmin(sql,execute,()=>{});
  await db.batch([
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.officer',?,'OFFICER')").bind(OFFICER,tenHash),
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.legacy',?,'ADMIN')").bind(LEGACY,legacyHash),
    db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES(?,'synthetic.inactive',?,'OFFICER',0)").bind(INACTIVE,tenHash),
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.corrupt','pbkdf2-sha256$10$broken$broken','OFFICER')").bind(CORRUPT),
  ]);
});
afterAll(async()=>{try{await mf?.dispose();}finally{if(outdir)await rm(outdir,{recursive:true,force:true});}});

 describe('approved production 10 in bundled workerd with actual D1',()=>{
  it('verifies Node bootstrap 10, leaves it unchanged, and preserves TTL/cookie/login/me/logout',async()=>{
    const response=await login('synthetic.admin'); expect(response.status).toBe(200); const token=tokenOf(response);
    const body=await response.json(); expect(body).toMatchObject({user:{id:ADMIN,role:'ADMIN'},active_raid_session:null});
    const stored=await assertHash(ADMIN,PASSWORD,10); expect(stored===tenHash).toBe(true);
    const session=await db.prepare('SELECT token_hash,expires_at-created_at AS ttl FROM user_sessions WHERE user_id=?').bind(ADMIN).first<{token_hash:string;ttl:number}>();
    expect(session?.ttl).toBe(43200); expect(session?.token_hash===await hashSessionToken(token)).toBe(true);
    expect((await me(token)).status).toBe(200);
    const logout=await post('/api/auth/logout',{},token); expect(logout.status).toBe(204); expect(logout.headers.get('set-cookie')).toBe(CLEARED);
    expect((await me(token)).status).toBe(401); expect(outbound).toBe(0);
  });
  it('verifies legacy Node 100000 without forced downgrade at configured 10',async()=>{
    const token=await loginToken('synthetic.legacy'); expect((await me(token)).status).toBe(200);
    const stored=await assertHash(LEGACY,PASSWORD,100000); expect(stored===legacyHash).toBe(true);
    expect((await verifyPassword(PASSWORD,stored,10)).needsRehash).toBe(false);
    expect(outbound).toBe(0);
  });
  it('rejects wrong, unknown, inactive, malformed usernames and corrupt hashes generically at 10',async()=>{
    let generic:string|undefined;
    for(const [username,password] of [['synthetic.admin','Synthetic-wrong'],['synthetic.missing',PASSWORD],['synthetic.inactive',PASSWORD],['bad username',PASSWORD],['synthetic.corrupt',PASSWORD]]) {
      const response=await login(username,password); expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body=await response.json() as {error:{code:string;message:string;request_id:string}};
      expect(body.error.code).toBe('INVALID_CREDENTIALS'); expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
      const projected=JSON.stringify({code:body.error.code,message:body.error.message});
      if(generic===undefined)generic=projected;else expect(projected===generic).toBe(true);
      for(const secret of [PASSWORD,tenHash,legacyHash,'password_hash','token_hash'])expect(JSON.stringify(body).includes(secret)).toBe(false);
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM user_sessions').first('n')).toBe(0); expect(outbound).toBe(0);
  });
  it('preserves OFFICER single-session, ADMIN multi-session and CSRF at configured 10',async()=>{
    const officer=await loginToken('synthetic.officer'); expect((await login('synthetic.officer')).status).toBe(409);
    expect((await me(officer)).status).toBe(200);
    const first=await loginToken('synthetic.admin'),second=await loginToken('synthetic.admin');
    expect((await me(first)).status).toBe(200); expect((await me(second)).status).toBe(200);
    expect((await post('/api/admin/users',{username:'synthetic.denied',password:REPLACEMENT,role:'OFFICER'},officer)).status).toBe(403);
    expect((await post('/api/auth/login',{username:'synthetic.admin',password:PASSWORD},undefined,'https://foreign.test')).status).toBe(403);
    expect(outbound).toBe(0);
  });
  it('creates and resets hashes with native workerd PBKDF2 10, independent Node verification and fresh salt',async()=>{
    const admin=await loginToken('synthetic.admin');
    const create=await post('/api/admin/users',{username:'synthetic.created',password:REPLACEMENT,role:'OFFICER'},admin); expect(create.status).toBe(201);
    const user=await create.json() as {id:string}; const first=await assertHash(user.id,REPLACEMENT,10);
    const officer=await loginToken('synthetic.created',REPLACEMENT);
    const reset=await post(`/api/admin/users/${user.id}/password`,{password:REPLACEMENT},admin); expect(reset.status).toBe(200);
    const second=await assertHash(user.id,REPLACEMENT,10); expect(second!==first).toBe(true);
    expect(await reset.json()).toMatchObject({signed_out:false,user:{active_session_count:0}});
    expect((await me(officer)).status).toBe(401); expect((await me(admin)).status).toBe(200);
    expect((await login('synthetic.created',REPLACEMENT)).status).toBe(200); expect(outbound).toBe(0);
  });
  it('self reset at 10 revokes all ADMIN sessions, clears cookie and rejects obsolete password',async()=>{
    const first=await loginToken('synthetic.admin'),second=await loginToken('synthetic.admin');
    const reset=await post(`/api/admin/users/${ADMIN}/password`,{password:REPLACEMENT},first); expect(reset.status).toBe(200);
    expect(reset.headers.get('set-cookie')).toBe(CLEARED);
    const body=await reset.json(); expect(body).toMatchObject({signed_out:true,user:{id:ADMIN,active_session_count:0}});
    await assertHash(ADMIN,REPLACEMENT,10);
    expect((await me(first)).status).toBe(401); expect((await me(second)).status).toBe(401);
    expect((await login('synthetic.admin')).status).toBe(401); expect((await login('synthetic.admin',REPLACEMENT)).status).toBe(200);
    for(const secret of [PASSWORD,REPLACEMENT,tenHash,first,second,'password_hash','token_hash'])expect(JSON.stringify(body).includes(secret)).toBe(false);
    expect(outbound).toBe(0);
  });
  it('rejects revoked, expired and deactivated sessions without changing configured 10',async()=>{
    const revoked=await loginToken('synthetic.admin');
    await db.prepare('UPDATE user_sessions SET revoked_at=max(unixepoch(),created_at) WHERE token_hash=?').bind(await hashSessionToken(revoked)).run();
    expect((await me(revoked)).status).toBe(401);
    const expired=generateSessionToken();
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,1,2)').bind(crypto.randomUUID(),ADMIN,await hashSessionToken(expired)).run();
    expect((await me(expired)).status).toBe(401);
    const officer=await loginToken('synthetic.officer'); await db.prepare('UPDATE users SET is_active=0 WHERE id=?').bind(OFFICER).run();
    expect((await me(officer)).status).toBe(401); expect((await login('synthetic.officer')).status).toBe(401);
    expect(outbound).toBe(0);
  });
});
