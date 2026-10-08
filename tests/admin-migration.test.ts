import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestMigrations, resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';
let mf: Miniflare, db: TestD1;
beforeAll(async () => { ({mf,db} = await startMigratedD1(undefined,'0002_history.sql')); });
afterAll(async () => { await mf?.dispose(); });
const oldActions = ['USER_CREATED','USER_UPDATED','USER_DEACTIVATED','SESSION_REVOKED','LOCATION_CREATED','LOCATION_UPDATED','LOCATION_DEACTIVATED'];
describe('0003 actual D1 populated upgrade and guards', () => {
 it('copies every historical field including inactive actor before enabling actor guard', async () => {
  await db.batch([
   db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('actor','synthetic.actor','unused','ADMIN'),('target','synthetic.target','unused','OFFICER'),('admin','synthetic.admin','unused','ADMIN')"),
   db.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')"),
   db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES('session','target',?,unixepoch()+1000)").bind('a'.repeat(64)),
   db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES('raid','target','location','A')"),
   db.prepare("INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source) VALUES('check','raid','target','check','DH1ZZ','NOT_FOUND','LIVE')"),
  ]);
  for (const [i,action] of oldActions.entries()) await db.prepare(`INSERT INTO admin_audit_logs(id,actor_user_id,action,${action === 'SESSION_REVOKED' ? 'target_session_id' : action.startsWith('LOCATION') ? 'target_location_id' : 'target_user_id'},occurred_at) VALUES(?,'actor',?,?,?)`).bind(`audit-${i}`,action,action === 'SESSION_REVOKED' ? 'session' : action.startsWith('LOCATION') ? 'location' : 'target',100+i).run();
  await db.prepare("UPDATE users SET is_active=0 WHERE id='actor'").run();
  const tables = ['admin_audit_logs','check_logs','locations','raid_sessions','user_sessions','users'];
  const original = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
  await applyTestMigrations(db,undefined,'0002_history.sql');
  for (const [i,table] of tables.entries()) expect((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results).toEqual(original[i]);
  expect(original[0]).toHaveLength(7); expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]); expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{name:string}>()).results.map((row: {name:string}) => row.name)).toEqual(tables);
  expect((await db.prepare('PRAGMA table_info(admin_audit_logs)').all<{name:string}>()).results.map((row: {name:string})=>row.name)).toEqual(['id','actor_user_id','action','target_user_id','target_session_id','target_location_id','occurred_at']);
  await expect(db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES('inactive','actor','USER_ACTIVATED','target')").run()).rejects.toThrow('Active admin required');
 });
 it('accepts typed new user actions, rejects wrong targets and keeps all FKs RESTRICT', async () => {
  for (const action of ['USER_ACTIVATED','USER_PASSWORD_RESET','USER_SESSIONS_REVOKED']) {
   await db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES(?,'admin',?,'target')").bind(action,action).run();
   await expect(db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_session_id) VALUES(?,'admin',?,'session')").bind(`bad-${action}`,action).run()).rejects.toThrow('CHECK constraint');
  }
  await expect(db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES('bad','admin','ARBITRARY','target')").run()).rejects.toThrow('CHECK constraint');
  const foreignKeys = (await db.prepare('PRAGMA foreign_key_list(admin_audit_logs)').all<{on_delete:string}>()).results; expect(foreignKeys).toHaveLength(4); expect(foreignKeys.every((row: {on_delete:string})=>row.on_delete==='RESTRICT')).toBe(true);
  for (const [table,id] of [['users','target'],['users','actor'],['user_sessions','session'],['locations','location']]) await expect(db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run()).rejects.toThrow('FOREIGN KEY');
 });
 it('rejects all audit UPDATE including no-op, preserves actor index and users paging plan', async () => {
  const original = (await db.prepare('SELECT * FROM admin_audit_logs ORDER BY id').all()).results;
  for (const update of ['id=id',"action='USER_UPDATED'",'occurred_at=999']) await expect(db.prepare(`UPDATE admin_audit_logs SET ${update}`).run()).rejects.toThrow('Admin audit log is immutable');
  expect((await db.prepare('SELECT * FROM admin_audit_logs ORDER BY id').all()).results).toEqual(original);
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all<{name:string}>()).results.map((row: {name:string})=>row.name)).toEqual(expect.arrayContaining(['admin_audit_logs_actor_time','users_created_id','check_logs_raid_nopol','check_logs_raid_checked_id']));
  const index = (await db.prepare('PRAGMA index_xinfo(users_created_id)').all<{name:string;desc:number;key:number}>()).results.filter((row: {key:number})=>row.key); expect(index.map((row: {name:string;desc:number})=>[row.name,row.desc])).toEqual([['created_at',1],['id',1]]);
  expect(JSON.stringify((await db.prepare('EXPLAIN QUERY PLAN SELECT id FROM users WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 21').bind(100,'target').all()).results)).toContain('users_created_id');
 });
 it('reset helper deletes six tables child-first without disabling FK or immutable guards', async () => {
  await resetTestD1(db);
  for (const table of ['admin_audit_logs','check_logs','locations','raid_sessions','user_sessions','users']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
  expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
 });
});
