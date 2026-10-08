import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../shared/password';
import { createApp } from '../worker/index';
import type { AdminUser } from '../worker/admin';
import { encodeHistoryCursor } from '../worker/history';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

// Real D1/workerd, synthetic data. Fixture hashing is 1000; application config stays 100000/43200.
const ORIGIN = 'https://app.test';
const PASSWORD = 'Synthetic-old-password';
const IDS = { admin: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222', officer: '33333333-3333-4333-8333-333333333333', missing: '99999999-9999-4999-8999-999999999999' };
const CLEAR = '__Host-rs_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';
const BASE = '/api/admin/users';
let mf: Miniflare, db: TestD1, app: ReturnType<typeof createApp>, override: D1Database | undefined;
let tokens: Record<string,string>, sessions: Record<string,string>, lines: string[], fixtureHash: string;
const vars = { PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' };
const sql = (query: string, ...values: (string | number | null)[]) => db.prepare(query).bind(...values).run();
const count = (table = 'admin_audit_logs') => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
const env = () => ({ DB: override ?? db, ...vars }) as unknown as Env;
function call(path: string, body?: unknown, token = tokens.admin, extra: Record<string,string> = {}): Promise<Response> {
 return Promise.resolve(app.request(`${ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `__Host-rs_session=${token}`, ...(body === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }, env()));
}
async function error(response: Response, status: number, code: string) {
 expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
 expect(await response.json()).toEqual({ error: { code, message: expect.any(String), request_id: response.headers.get('x-request-id') } });
}
async function session(userId: string, expired = false) {
 const id = crypto.randomUUID(); const token = generateSessionToken();
 await sql(`INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,${expired ? '1,2' : 'unixepoch(),unixepoch()+43200'})`, id,userId,await hashSessionToken(token));
 return { id,token };
}
function intercept(before: () => Promise<void>, batchNumber = 1, futureClock = false, after?: () => Promise<void>) {
 const real = db as unknown as D1Database; let n = 0;
 override = { prepare: (query: string) => real.prepare(futureClock && query.includes('s.id = ? AND s.user_id = ?') ? query.replaceAll('s.expires_at > unixepoch()', 's.expires_at > (unixepoch()+43201)') : query), batch: async (statements: D1PreparedStatement[]) => { n++; if (n === batchNumber) await before(); const result = await real.batch(statements); if (n === batchNumber) await after?.(); return result; } } as D1Database;
}
const revokeActor = () => sql('UPDATE user_sessions SET revoked_at=max(unixepoch(),created_at) WHERE id=?',sessions.admin).then(() => {});
function assertDto(user: AdminUser) {
 expect(Object.keys(user).sort()).toEqual(['active_session_count','created_at','id','is_active','role','updated_at','username']);
 expect(typeof user.is_active).toBe('boolean'); expect(user.id).toMatch(/^[0-9a-f-]{36}$/); expect(Number.isInteger(user.active_session_count)).toBe(true);
}
beforeAll(async () => { ({mf,db} = await startMigratedD1()); fixtureHash = await hashPassword(PASSWORD,1000); });
beforeEach(async () => {
 await resetTestD1(db); override = undefined; lines = []; tokens = {}; sessions = {};
 app = createApp(createSafeLogger(line => lines.push(line)));
 for (const [name,id] of Object.entries(IDS).filter(([name]) => name !== 'missing')) {
  await sql('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', id,`synthetic.${name}`,fixtureHash,name === 'officer' ? 'OFFICER' : 'ADMIN');
  const seeded = await session(id); tokens[name] = seeded.token; sessions[name] = seeded.id;
 }
});
afterAll(async () => { await mf?.dispose(); });

describe('admin API contract and minimization', () => {
 it('lists and details only allowlisted DTO fields and counts active sessions', async () => {
  await session(IDS.other); await session(IDS.other,true);
  const result = await call(BASE); expect(result.status).toBe(200);
  const body = await result.json() as {users: AdminUser[];next_cursor:string|null};
  expect(body.users).toHaveLength(3); expect(body.next_cursor).toBeNull(); body.users.forEach(assertDto);
  expect(body.users.find(user => user.id === IDS.other)?.active_session_count).toBe(2);
  expect(await (await call(`${BASE}/${IDS.other}`)).json()).toEqual(body.users.find(user => user.id === IDS.other));
  for (const value of [fixtureHash,PASSWORD,...Object.values(tokens),'token_hash','password_hash','revoked_at']) expect(JSON.stringify(body)).not.toContain(value);
 });
 it('creates with normalized username, create-only role, actual baseline hash and typed audit', async () => {
  const response = await call(BASE,{username:'  Synthetic.New ',password:'x',role:'ADMIN'}); expect(response.status).toBe(201);
  const user = await response.json() as AdminUser; assertDto(user);
  expect(user).toMatchObject({username:'synthetic.new',role:'ADMIN',is_active:true,active_session_count:0});
  const hash = await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first<string>('password_hash');
  expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/); expect((await verifyPassword('x',hash!)).ok).toBe(true);
  expect(await db.prepare('SELECT action,target_user_id,target_session_id FROM admin_audit_logs').first()).toEqual({action:'USER_CREATED',target_user_id:user.id,target_session_id:null});
 });
 it('atomically resolves concurrent normalized duplicate usernames with one audit', async () => {
  const responses = await Promise.all([' Synthetic.Duplicate ','synthetic.duplicate'].map(username => call(BASE,{username,password:'x',role:'OFFICER'})));
  expect(responses.map(response => response.status).sort()).toEqual([201,409]);
  await error(responses.find(response => response.status === 409)!,409,'USERNAME_TAKEN');
  expect(await count()).toBe(1); expect(await count('users')).toBe(4);
 });
 it.each([{},[],null,'','{', {username:'a',password:'x'}, {username:'a',password:'',role:'ADMIN'}, {username:'a',password:'é'.repeat(513),role:'ADMIN'}, {username:'a',password:1,role:'ADMIN'}, {username:'bad user',password:'x',role:'ADMIN'}, {username:'K',password:'x',role:'ADMIN'}, {username:'a',password:'x',role:'admin'}, {username:'a',password:'x',role:'CLIENT'}, {username:'a',password:'x',role:'OFFICER',is_active:false}, {username:'a',password:'x',role:'ADMIN',actor_user_id:IDS.admin}])('rejects invalid create body %# without hashing', async body => {
  const spy = vi.spyOn(crypto.subtle,'deriveBits');
  try { await error(await call(BASE,body),400,'INVALID_INPUT'); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
  expect(await count()).toBe(0);
 });
 it('rejects unauthorized expensive work before body validation or hashing', async () => {
  const spy = vi.spyOn(crypto.subtle,'deriveBits');
  try {
   await error(await call(BASE,{username:'x',password:'x',role:'ADMIN'},tokens.officer),403,'AUTHORIZATION_ERROR');
   await error(await call(BASE,{username:'x',password:'x',role:'ADMIN'},''),401,'AUTHENTICATION_ERROR');
   await error(await call(`${BASE}/bad/password`,{password:'x'},tokens.officer),403,'AUTHORIZATION_ERROR'); expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
 });
 it.each(['bad',IDS.missing])('returns authorized-only consistent missing target errors: %s', async id => {
  await error(await call(`${BASE}/${id}`),404,'USER_NOT_FOUND');
  await error(await call(`${BASE}/${id}/password`,{password:'x'}),404,'USER_NOT_FOUND');
  await error(await call(`${BASE}/${id}/activate`,{}),404,'USER_NOT_FOUND');
  await error(await call(`${BASE}/${id}/sessions`),404,'SESSION_NOT_FOUND');
  await error(await call(`${BASE}/${id}/sessions/revoke`,{}),404,'SESSION_NOT_FOUND');
  const response = await call(`${BASE}/${id}`,undefined,tokens.officer); await error(response,403,'AUTHORIZATION_ERROR'); expect(response.headers.get('set-cookie')).toBeNull();
 });
 it('keeps role updates, rename, deletion and audit listing unavailable', async () => {
  for (const suffix of ['/role','/rename','/delete']) await error(await call(`${BASE}/${IDS.officer}${suffix}`,{}),404,'ROUTE_NOT_FOUND');
  await error(await call('/api/admin/audit'),404,'ROUTE_NOT_FOUND');
 });
 it('enforces CSRF and 4096-byte body cap with safe error logging', async () => {
  await error(await call(BASE,{username:'x',password:'x',role:'ADMIN'},tokens.admin,{Origin:'https://evil.test'}),403,'CSRF_REJECTED');
  await error(await call(BASE,{padding:'SENSITIVE'.repeat(700)}),413,'PAYLOAD_TOO_LARGE');
  for (const value of [PASSWORD,fixtureHash,...Object.values(tokens),'SENSITIVE','synthetic','rs_session']) expect(lines.join('\n')).not.toContain(value);
  for (const line of lines) expect(Object.keys(JSON.parse(line)).sort()).toEqual(['code','event','request_id']);
 });
});

describe('activation, deactivation and last-admin safety', () => {
 it('is idempotent, revokes without restoring sessions and preserves ACTIVE raid/history/D5-02', async () => {
  await sql("INSERT INTO locations(id,name) VALUES('location','Synthetic location')");
  await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid',?,'location','A')",IDS.officer);
  const first = await call(`${BASE}/${IDS.officer}/deactivate`,{}); expect(first.status).toBe(200); expect(await first.json()).toMatchObject({is_active:false,active_session_count:0});
  expect((await call('/api/auth/me',undefined,tokens.officer)).status).toBe(401);
  expect((await call(`${BASE}/${IDS.officer}/deactivate`,{})).status).toBe(200); expect(await count()).toBe(1);
  await sql("INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source) VALUES('late','raid',?,'late','DH1ZZ','NOT_FOUND','LIVE')",IDS.officer);
  expect((await call(`${BASE}/${IDS.officer}/activate`,{})).status).toBe(200);
  expect((await call(`${BASE}/${IDS.officer}/activate`,{})).status).toBe(200); expect(await count()).toBe(2);
  expect((await call('/api/auth/me',undefined,tokens.officer)).status).toBe(401);
  expect(await db.prepare("SELECT status FROM raid_sessions WHERE id='raid'").first('status')).toBe('ACTIVE'); expect(await count('check_logs')).toBe(1);
  expect((await db.prepare('SELECT action FROM admin_audit_logs ORDER BY rowid').all()).results).toEqual([{action:'USER_DEACTIVATED'},{action:'USER_ACTIVATED'}]);
 });
 it('forbids self-deactivation without mutation/audit', async () => {
  await error(await call(`${BASE}/${IDS.admin}/deactivate`,{}),409,'SELF_DEACTIVATION_FORBIDDEN');
  expect(await count()).toBe(0); expect((await call('/api/auth/me')).status).toBe(200);
 });
 it('serializes two admins deactivating one another and leaves one active admin', async () => {
  const results = await Promise.all([call(`${BASE}/${IDS.other}/deactivate`,{}),call(`${BASE}/${IDS.admin}/deactivate`,{},tokens.other)]);
  expect(results.map(result => result.status).sort()).toEqual([200,401]);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='ADMIN' AND is_active=1").first('n')).toBe(1); expect(await count()).toBe(1);
 });
 it.each([['activate',{is_active:1}],['deactivate',{role:'ADMIN'}],['activate',''],['deactivate','[]']])('strictly validates %s body', async (action,body) => { await error(await call(`${BASE}/${IDS.officer}/${action}`,body),400,'INVALID_INPUT'); });
});

describe('password and session reset', () => {
 it.each([{}, {password:''}, {password:'é'.repeat(513)}, {password:null}, {password:'x',role:'ADMIN'}])('rejects password body %#', async body => { await error(await call(`${BASE}/${IDS.other}/password`,body),400,'INVALID_INPUT'); });
 it('resets password, revokes all target rows, invalidates old password and preserves other admin', async () => {
  const second = await session(IDS.other); await session(IDS.other,true);
  const result = await call(`${BASE}/${IDS.other}/password`,{password:'x'}); expect(result.status).toBe(200); expect(result.headers.get('set-cookie')).toBeNull();
  expect(await result.json()).toMatchObject({user:{id:IDS.other,active_session_count:0},signed_out:false});
  expect(await db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id=? AND revoked_at IS NULL').bind(IDS.other).first('n')).toBe(0);
  for (const token of [tokens.other,second.token]) expect((await call('/api/auth/me',undefined,token)).status).toBe(401);
  await error(await call('/api/auth/login',{username:'synthetic.other',password:PASSWORD}),401,'INVALID_CREDENTIALS');
  expect((await call('/api/auth/login',{username:'synthetic.other',password:'x'},'')).status).toBe(200); expect((await call('/api/auth/me')).status).toBe(200);
  expect(await db.prepare('SELECT action FROM admin_audit_logs').first('action')).toBe('USER_PASSWORD_RESET');
 });
 it('self-password reset returns authoritative 200 signed_out with clear cookie after commit', async () => {
  const another = await session(IDS.admin);
  const result = await call(`${BASE}/${IDS.admin}/password`,{password:'x'}); expect(result.status).toBe(200); expect(result.headers.get('set-cookie')).toBe(CLEAR);
  expect(await result.json()).toMatchObject({signed_out:true,user:{active_session_count:0}});
  for (const token of [tokens.admin,another.token]) expect((await call('/api/auth/me',undefined,token)).status).toBe(401);
  expect(await count()).toBe(1);
 });
 it('lists only active minimal sessions, current marker is server-derived', async () => {
  await session(IDS.admin); await session(IDS.admin,true);
  const result = await call(`${BASE}/${IDS.admin}/sessions`); const body = await result.json() as {sessions:{id:string;is_current:boolean}[];next_cursor:null};
  expect(body.sessions).toHaveLength(2); expect(body.next_cursor).toBeNull();
  expect(body.sessions.filter(item => item.is_current).map(item => item.id)).toEqual([sessions.admin]);
  for (const item of body.sessions) expect(Object.keys(item).sort()).toEqual(['created_at','expires_at','id','is_current']);
  for (const value of [...Object.values(tokens),fixtureHash,'token_hash','device','cookie']) expect(JSON.stringify(body)).not.toContain(value);
 });
 it('revokes one owned session, keeps current and other devices, then self-current signs out', async () => {
  const second = await session(IDS.admin); const third = await session(IDS.admin);
  const result = await call(`${BASE}/${IDS.admin}/sessions/revoke`,{session_id:second.id}); expect(result.status).toBe(200); expect(result.headers.get('set-cookie')).toBeNull();
  expect(await result.json()).toMatchObject({user:{active_session_count:2},signed_out:false});
  expect((await call('/api/auth/me',undefined,second.token)).status).toBe(401);
  expect((await call('/api/auth/me',undefined,third.token)).status).toBe(200); expect((await call('/api/auth/me')).status).toBe(200);
  expect((await call(`${BASE}/${IDS.admin}/sessions/revoke`,{session_id:second.id})).status).toBe(200); expect(await count()).toBe(1);
  const current = await call(`${BASE}/${IDS.admin}/sessions/revoke`,{session_id:sessions.admin}); expect(current.status).toBe(200); expect(current.headers.get('set-cookie')).toBe(CLEAR);
  expect(await current.json()).toMatchObject({user:{active_session_count:1},signed_out:true}); expect((await call('/api/auth/me',undefined,third.token)).status).toBe(200);
  expect((await db.prepare('SELECT action,target_session_id,target_user_id FROM admin_audit_logs ORDER BY rowid').all()).results).toEqual([{action:'SESSION_REVOKED',target_session_id:second.id,target_user_id:null},{action:'SESSION_REVOKED',target_session_id:sessions.admin,target_user_id:null}]);
 });
 it('rejects cross-user, malformed and missing session IDs before any write', async () => {
  for (const session_id of [sessions.other,'bad',IDS.missing]) await error(await call(`${BASE}/${IDS.admin}/sessions/revoke`,{session_id}),404,'SESSION_NOT_FOUND');
  expect(await count()).toBe(0); expect((await call('/api/auth/me',undefined,tokens.other)).status).toBe(200);
 });
 it.each([{session_id:1},{session_id:null},{session_id:IDS.admin,actor_user_id:IDS.admin},{all:true},'','[]'])('rejects revoke body %#', async body => { await error(await call(`${BASE}/${IDS.other}/sessions/revoke`,body),400,'INVALID_INPUT'); });
 it('revoke all is idempotent without active sessions and self-all signs out', async () => {
  const other = await call(`${BASE}/${IDS.other}/sessions/revoke`,{}); expect(await other.json()).toMatchObject({signed_out:false,user:{active_session_count:0}});
  expect((await call(`${BASE}/${IDS.other}/sessions/revoke`,{})).status).toBe(200); expect(await count()).toBe(1);
  expect(await db.prepare('SELECT action,target_user_id FROM admin_audit_logs').first()).toEqual({action:'USER_SESSIONS_REVOKED',target_user_id:IDS.other});
  await session(IDS.admin); const self = await call(`${BASE}/${IDS.admin}/sessions/revoke`,{}); expect(self.status).toBe(200); expect(self.headers.get('set-cookie')).toBe(CLEAR);
  expect(await self.json()).toMatchObject({signed_out:true,user:{active_session_count:0}}); expect((await call('/api/auth/me')).status).toBe(401);
 });
});

describe('pagination and strict query allowlists', () => {
 it('bounds users 20/default, 50/max with timestamp+UUID tie pagination and index plan', async () => {
  await db.batch(Array.from({length:52},(_,i) => db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES(?,?,?,\'OFFICER\',100,100)').bind(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,'0')}`,`synthetic.page.${i}`,fixtureHash)));
  const first = await (await call(BASE)).json() as {users:AdminUser[];next_cursor:string}; expect(first.users).toHaveLength(20);
  const seen = first.users.map(user => user.id); let cursor = first.next_cursor;
  while (cursor) { const page = await (await call(`${BASE}?cursor=${cursor}`)).json() as typeof first; seen.push(...page.users.map(user => user.id)); cursor = page.next_cursor; }
  expect(seen).toHaveLength(55); expect(new Set(seen).size).toBe(55); expect((await (await call(`${BASE}?limit=50`)).json() as typeof first).users).toHaveLength(50);
  const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT id FROM users WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?').bind(100,IDS.missing,21).all(); expect(JSON.stringify(plan.results)).toContain('users_created_id');
 });
 it('bounds active session pages without token material', async () => {
  for (let i=0;i<22;i++) await session(IDS.admin);
  const first = await (await call(`${BASE}/${IDS.admin}/sessions`)).json() as {sessions:{id:string}[];next_cursor:string}; expect(first.sessions).toHaveLength(20);
  const last = await (await call(`${BASE}/${IDS.admin}/sessions?cursor=${first.next_cursor}`)).json() as typeof first;
  expect(last.sessions).toHaveLength(3); expect(last.next_cursor).toBeNull(); expect(new Set([...first.sessions,...last.sessions].map(item=>item.id)).size).toBe(23);
 });
 it.each(['limit=0','limit=51','limit=01','limit=1.5','limit=','limit=20&limit=20','cursor=','cursor=bad','cursor='+encodeHistoryCursor(100,'bad'),'user_id='+IDS.admin,'sort=username','cursor='+encodeHistoryCursor(100,IDS.admin)+'='])('rejects malformed/extra paging query %s', async query => {
  await error(await call(`${BASE}?${query}`),400,'INVALID_INPUT'); await error(await call(`${BASE}/${IDS.admin}/sessions?${query}`),400,'INVALID_INPUT');
 });
 it('rejects query params on unpaged reads and writes', async () => {
  await error(await call(`${BASE}/${IDS.admin}?limit=20`),400,'INVALID_INPUT'); await error(await call(`${BASE}/${IDS.other}/activate?x=1`,{}),400,'INVALID_INPUT');
 });
});

describe('atomic exact actor guards and audit rollback', () => {
 it.each(['list','detail','sessions','create','activate','deactivate','password','revoke-all','revoke-one'])('blocks revoked actor after middleware on %s', async action => {
  const second = await session(IDS.admin); intercept(revokeActor);
  let response: Response;
  if (action === 'list') response = await call(BASE);
  else if (action === 'detail') response = await call(`${BASE}/${IDS.other}`);
  else if (action === 'sessions') response = await call(`${BASE}/${IDS.other}/sessions`);
  else if (action === 'create') response = await call(BASE,{username:'x',password:'x',role:'ADMIN'});
  else response = await call(`${BASE}/${IDS.other}/${action.startsWith('revoke') ? 'sessions/revoke' : action}`,action === 'password' ? {password:'x'} : action === 'revoke-one' ? {session_id:sessions.other} : {});
  await error(response,401,'AUTHENTICATION_ERROR'); expect(response.headers.get('set-cookie')).toBe(CLEAR); expect(await count()).toBe(0);
  override = undefined; expect((await call('/api/auth/me',undefined,second.token)).status).toBe(200);
 });
 it.each(['expired','inactive','demoted'])('rejects stale %s actor without unauthorized mutation', async kind => {
  intercept(async () => { if (kind === 'inactive') await sql('UPDATE users SET is_active=0 WHERE id=?',IDS.admin); if (kind === 'demoted') await sql("UPDATE users SET role='OFFICER' WHERE id=?",IDS.admin); },1,kind === 'expired');
  const response = await call(`${BASE}/${IDS.other}/deactivate`,{}); await error(response,kind === 'demoted' ? 403 : 401,kind === 'demoted' ? 'AUTHORIZATION_ERROR' : 'AUTHENTICATION_ERROR');
  expect(response.headers.get('set-cookie')).toBe(kind === 'demoted' ? null : CLEAR); expect(await count()).toBe(0);
 });
 it.each(['create','password'])('rechecks actor after password hashing before %s write', async action => {
  intercept(revokeActor,2);
  const response = action === 'create' ? await call(BASE,{username:'x',password:'x',role:'ADMIN'}) : await call(`${BASE}/${IDS.other}/password`,{password:'x'});
  await error(response,401,'AUTHENTICATION_ERROR'); expect(await count()).toBe(0); expect(await count('users')).toBe(3);
  expect(await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(IDS.other).first('password_hash')).toBe(fixtureHash);
 });
 it.each(['create','deactivate','password','revoke'])('rolls back %s and exposes only generic error when typed audit fails', async action => {
  await sql("CREATE TRIGGER test_audit_failure BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT,'SENSITIVE-audit-failure'); END;");
  try {
   const response = action === 'create' ? await call(BASE,{username:'x',password:'x',role:'ADMIN'}) : await call(`${BASE}/${IDS.other}/${action === 'revoke' ? 'sessions/revoke' : action}`,action === 'password' ? {password:'x'} : {});
   await error(response,500,'INTERNAL_ERROR'); expect(await count()).toBe(0); expect(await count('users')).toBe(3);
   expect(await db.prepare('SELECT is_active,password_hash FROM users WHERE id=?').bind(IDS.other).first()).toEqual({is_active:1,password_hash:fixtureHash});
   expect(await db.prepare('SELECT revoked_at FROM user_sessions WHERE id=?').bind(sessions.other).first('revoked_at')).toBeNull(); expect(lines.join('\n')).not.toContain('SENSITIVE');
  } finally { await sql('DROP TRIGGER test_audit_failure'); }
 });
 it('does not hide an authorized committed mutation after a subsequent revoke', async () => {
  intercept(async () => {},1,false,revokeActor); const response = await call(`${BASE}/${IDS.other}/deactivate`,{}); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({is_active:false}); expect(await count()).toBe(1);
 });
});

describe('PBKDF2 await boundaries and actual guarded query plans', () => {
 it.each([false,true])('invalidates a login snapshot during actual PBKDF2, rehash=%s', async rehash => {
  if (!rehash) await sql('UPDATE users SET password_hash=? WHERE id=?',await hashPassword(PASSWORD,100000),IDS.other);
  const replacement = await hashPassword('Replacement',1000);
  const derive = crypto.subtle.deriveBits.bind(crypto.subtle); let intercepted = false;
  const spy = vi.spyOn(crypto.subtle,'deriveBits').mockImplementation(async (...args) => {
   if (!intercepted) { intercepted = true; await sql('UPDATE users SET password_hash=? WHERE id=?',replacement,IDS.other); }
   return derive(...args);
  });
  try { const response = await call('/api/auth/login',{username:'synthetic.other',password:PASSWORD}); await error(response,401,'INVALID_CREDENTIALS'); expect(response.headers.get('set-cookie')).toBeNull(); }
  finally { spy.mockRestore(); }
  expect(await count('user_sessions')).toBe(3); expect((await call('/api/auth/me')).status).toBe(200);
  expect(await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(IDS.other).first('password_hash')).toBe(replacement);
 });
 it.each(['create','password'])('blocks demotion during actual password hash on %s with 403 and no logout', async action => {
  const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle,'deriveBits').mockImplementation(async (...args) => { await sql("UPDATE users SET role='OFFICER' WHERE id=?",IDS.admin); return derive(...args); });
  try {
   const response = action === 'create' ? await call(BASE,{username:'x',password:'x',role:'ADMIN'}) : await call(`${BASE}/${IDS.other}/password`,{password:'x'});
   await error(response,403,'AUTHORIZATION_ERROR'); expect(response.headers.get('set-cookie')).toBeNull();
  } finally { spy.mockRestore(); }
  expect(await count()).toBe(0); expect(await count('users')).toBe(3); expect((await call('/api/auth/me')).status).toBe(200);
 });
 it('uses indexes on the actual route SQL with exact actor guard and bounded limit', async () => {
  const real = db as unknown as D1Database; const prepared: {query:string;values:(string|number)[]}[] = [];
  override = { prepare: (query: string) => ({ bind: (...values: (string|number)[]) => { prepared.push({query,values}); return real.prepare(query).bind(...values); } }), batch: (statements: D1PreparedStatement[]) => real.batch(statements) } as D1Database;
   expect((await call(`${BASE}?limit=20&cursor=${encodeHistoryCursor(2000000000,IDS.missing)}`)).status).toBe(200);
  expect((await call(`${BASE}/${IDS.admin}/sessions?limit=20`)).status).toBe(200);
  override = undefined;
  const queries = prepared.filter(item => item.query.includes('ORDER BY'));
  expect(queries).toHaveLength(2);
  for (const [i,item] of queries.entries()) {
   expect(item.query).toContain("WHERE role = 'ADMIN'"); expect(item.values).toContain(sessions.admin); expect(item.values[item.values.length-1]).toBe(21);
   const plan = await db.prepare(`EXPLAIN QUERY PLAN ${item.query}`).bind(...item.values).all();
   expect(JSON.stringify(plan.results)).toContain(i === 0 ? 'users_created_id' : 'user_sessions_user_expiry');
  }
 });
});

describe('verified-hash login races', () => {
 it.each([false,true])('rejects concurrent password reset before login batch, rehash=%s, without rotating valid cookie', async rehash => {
  if (!rehash) await sql('UPDATE users SET password_hash=? WHERE id=?',await hashPassword(PASSWORD,100000),IDS.other);
  const replacement = await hashPassword('Replacement',1000); intercept(async () => { await sql('UPDATE users SET password_hash=? WHERE id=?',replacement,IDS.other); });
  const response = await call('/api/auth/login',{username:'synthetic.other',password:PASSWORD}); await error(response,401,'INVALID_CREDENTIALS'); expect(response.headers.get('set-cookie')).toBeNull();
  expect(await count('user_sessions')).toBe(3); expect(await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(IDS.other).first('password_hash')).toBe(replacement);
  override = undefined; expect((await call('/api/auth/me')).status).toBe(200);
 });
 it('rejects deactivation after verify before batch without rotating another valid cookie', async () => {
  intercept(async () => { await sql('UPDATE users SET is_active=0 WHERE id=?',IDS.other); });
  await error(await call('/api/auth/login',{username:'synthetic.other',password:PASSWORD}),401,'INVALID_CREDENTIALS'); expect(await count('user_sessions')).toBe(3);
  override = undefined; expect((await call('/api/auth/me')).status).toBe(200);
 });
 it('responds with current role from DB rather than verified snapshot', async () => {
  intercept(async () => { await sql("UPDATE users SET role='OFFICER' WHERE id=?",IDS.other); });
  const response = await call('/api/auth/login',{username:'synthetic.other',password:PASSWORD},tokens.other); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({user:{role:'OFFICER',username:'synthetic.other'}});
 });
 it('preserves the OFFICER single-session trigger under concurrent valid login', async () => {
  // No rehash race in this policy test: both attempts verify the same production-strength hash.
  await sql('UPDATE users SET password_hash=? WHERE id=?',await hashPassword(PASSWORD,100000),IDS.officer);
  await sql('UPDATE user_sessions SET revoked_at=max(unixepoch(),created_at) WHERE user_id=?',IDS.officer);
  const responses = await Promise.all([call('/api/auth/login',{username:'synthetic.officer',password:PASSWORD},''),call('/api/auth/login',{username:'synthetic.officer',password:PASSWORD},'')]);
  expect(responses.map(response=>response.status).sort()).toEqual([200,409]); expect(await db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id=? AND revoked_at IS NULL').bind(IDS.officer).first('n')).toBe(1);
 });
});
