import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../shared/password';
import { startMigratedD1, type TestD1 } from './helpers/miniflare';

// Only this new Phase6 smoke uses repository-local bundles; existing smoke harnesses stay unchanged.
const ROOT = fileURLToPath(new URL('..',import.meta.url));
const ORIGIN = 'https://app.test';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'Synthetic-bundled-admin';
let outdir: string | undefined, mf: Miniflare | undefined, db: TestD1;
let outbound = 0;
const post = (path: string, body: unknown, token?: string) => mf!.dispatchFetch(`${ORIGIN}${path}`,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',...(token ? {Cookie:`__Host-rs_session=${token}`} : {})},body:JSON.stringify(body)});
beforeAll(async () => {
 const parent = join(ROOT,'.wrangler','test-bundles'); await mkdir(parent,{recursive:true}); outdir = await mkdtemp(join(parent,'phase6-'));
 const result = spawnSync(process.execPath,[join(ROOT,'node_modules','wrangler','bin','wrangler.js'),'deploy','--dry-run','--outdir',outdir],{cwd:ROOT,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true'}});
 if (result.status !== 0) throw new Error(`wrangler dry-run failed: ${result.stderr}`);
 ({mf,db} = await startMigratedD1({modules:true,modulesRoot:ROOT,scriptPath:join(outdir,'index.js'),bindings:{PASSWORD_PBKDF2_ITERATIONS:'100000',SESSION_TTL_SECONDS:'43200',RETENTION_POLICY:'UNSET'},outboundService:() => { outbound++; return new Response('Outbound disabled in synthetic admin smoke',{status:503}); }}));
 await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.admin',?,'ADMIN')").bind(ADMIN,await hashPassword(PASSWORD,1000)).run();
},180000);
afterAll(async () => { try { await mf?.dispose(); } finally { if (outdir) await rm(outdir,{recursive:true,force:true}); } });
it('production bundle runs admin create/detail/sessions/reset/self-signout with actual workerd crypto and no outbound', async () => {
 const login = await post('/api/auth/login',{username:'synthetic.admin',password:PASSWORD}); expect(login.status).toBe(200);
 const token = /^__Host-rs_session=([A-Za-z0-9_-]{43});/.exec(login.headers.get('set-cookie') ?? '')?.[1]; expect(token).toBeDefined();
 const created = await post('/api/admin/users',{username:' Synthetic.Officer ',password:'x',role:'OFFICER'},token); expect(created.status).toBe(201);
 const user = await created.json() as {id:string;username:string}; expect(user.username).toBe('synthetic.officer');
 const hash = await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first<string>('password_hash'); expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/); expect((await verifyPassword('x',hash!)).ok).toBe(true);
 const detail = await mf!.dispatchFetch(`${ORIGIN}/api/admin/users/${user.id}`,{headers:{Cookie:`__Host-rs_session=${token}`}}); expect(detail.status).toBe(200); expect(await detail.json()).toEqual(user);
 const list = await mf!.dispatchFetch(`${ORIGIN}/api/admin/users/${ADMIN}/sessions`,{headers:{Cookie:`__Host-rs_session=${token}`}}); expect(list.status).toBe(200); expect(await list.json()).toMatchObject({sessions:[{is_current:true}],next_cursor:null});
 const denied = await post(`/api/admin/users/${user.id}/deactivate`,{},token); expect(denied.status).toBe(200);
 const reset = await post(`/api/admin/users/${ADMIN}/password`,{password:'Replacement'},token); expect(reset.status).toBe(200);
 expect(reset.headers.get('set-cookie')).toBe('__Host-rs_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict');
 const result = await reset.json(); expect(result).toMatchObject({signed_out:true,user:{id:ADMIN,active_session_count:0}});
 for (const secret of [PASSWORD,'Replacement',token!,hash!,'password_hash','token_hash']) expect(JSON.stringify([user,result])).not.toContain(secret);
 expect((await mf!.dispatchFetch(`${ORIGIN}/api/auth/me`,{headers:{Cookie:`__Host-rs_session=${token}`}})).status).toBe(401);
 expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(3); expect(outbound).toBe(0);
},60000);
