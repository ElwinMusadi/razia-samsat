import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

let mf: Miniflare;
let db: TestD1;
const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
const session = (id: string, user: string, hash: string, expires?: number) => sql('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)', id, user, hash.repeat(64), expires ?? Math.floor(Date.now()/1000)+3600);
const raid = (id: string, user = 'officer', location = 'location', lane = 'Jalur Utara A') => sql('INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES(?,?,?,?)', id,user,location,lane);
const log = (id: string, raidId = 'raid', user = 'officer', outcome = 'FOUND', tax: string | null = 'UNKNOWN', stnk: string | null = 'ACTIVE', source = 'LIVE', key = id, nopol = 'DH1234ZZ') => sql('INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,tax_status,stnk_status,source) VALUES(?,?,?,?,?,?,?,?,?)', id,raidId,user,key,nopol,outcome,tax,stnk,source);

beforeAll(async () => { ({ mf, db } = await startMigratedD1()); });
beforeEach(async () => {
  await resetTestD1(db);
  await sql("INSERT INTO users(id,username,password_hash,role) VALUES('officer','synthetic.officer','not-a-real-hash','OFFICER'),('admin','synthetic.admin','not-a-real-hash','ADMIN'),('other','synthetic.other','not-a-real-hash','OFFICER')");
  await sql("INSERT INTO locations(id,name) VALUES('location','Synthetic location')");
});
afterAll(async () => { await mf?.dispose(); });

describe('actual workerd D1 foundation migration', () => {
  it('has exactly six application tables, no owner/full-record fields and foreign keys enabled', async () => {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{name:string}>();
    expect(tables.results.map((row: {name: string}) => row.name)).toEqual(['admin_audit_logs','check_logs','locations','raid_sessions','user_sessions','users']);
    expect(await db.prepare('PRAGMA foreign_keys').first<number>('foreign_keys')).toBe(1);
    const columns = await db.prepare('PRAGMA table_info(check_logs)').all<{name:string}>();
    expect(columns.results.map((row: {name: string}) => row.name)).toEqual(['id','raid_session_id','user_id','idempotency_key','nopol','outcome','tax_status','stnk_status','source','checked_at']);
  });
  it('enforces role, active flags, username uniqueness and basic timestamps', async () => {
    await expect(sql("UPDATE users SET role='CLIENT' WHERE id='officer'")).rejects.toThrow();
    await expect(sql("UPDATE users SET is_active=2 WHERE id='officer'")).rejects.toThrow();
    await expect(sql("UPDATE users SET username='synthetic.admin' WHERE id='officer'")).rejects.toThrow();
    await expect(sql("UPDATE locations SET name='  ' WHERE id='location'")).rejects.toThrow();
    await expect(sql("UPDATE users SET updated_at=0 WHERE id='officer'")).rejects.toThrow();
  });
  it('enforces officer single active and admin multiple active sessions without policy flag', async () => {
    await session('officer1','officer','a');
    await expect(session('officer2','officer','b')).rejects.toThrow('Officer session limit');
    await session('admin1','admin','c'); await session('admin2','admin','d');
    expect(await db.prepare("SELECT count(*) AS count FROM user_sessions WHERE user_id='admin'").first<number>('count')).toBe(2);
    await expect(sql("UPDATE users SET role='OFFICER' WHERE id='admin'")).rejects.toThrow('Revoke excess sessions');
    await sql("UPDATE user_sessions SET revoked_at=unixepoch() WHERE id='admin2'");
    await sql("UPDATE users SET role='OFFICER' WHERE id='admin'");
    await expect(session('admin3','admin','e')).rejects.toThrow('Officer session limit');
  });
  it('allows expired slot replacement but forbids expired extension/token/user mutation', async () => {
    await sql("INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES('expired','officer',?,1,2)", 'a'.repeat(64));
    await session('current','officer','b');
    await expect(sql("UPDATE user_sessions SET expires_at=unixepoch()+3600 WHERE id='expired'")).rejects.toThrow();
    await expect(sql("UPDATE user_sessions SET user_id='other' WHERE id='current'")).rejects.toThrow();
    await expect(sql("UPDATE user_sessions SET token_hash=? WHERE id='current'", 'c'.repeat(64))).rejects.toThrow();
  });
  it('revocation and deactivation are irreversible, reactivation never revives old sessions', async () => {
    await session('officer1','officer','a');
    await sql("UPDATE users SET is_active=0 WHERE id='officer'");
    expect(await db.prepare("SELECT revoked_at FROM user_sessions WHERE id='officer1'").first<number>('revoked_at')).toBeGreaterThan(0);
    await expect(session('officer2','officer','b')).rejects.toThrow('Inactive session user');
    await sql("UPDATE users SET is_active=1 WHERE id='officer'");
    await expect(sql("UPDATE user_sessions SET revoked_at=NULL WHERE id='officer1'")).rejects.toThrow();
    await session('officer2','officer','b');
  });
  it('enforces token SHA256 hex length uniqueness, expiry and user FK', async () => {
    await session('admin1','admin','a');
    await expect(session('admin2','admin','a')).rejects.toThrow();
    await expect(session('missing','missing','b')).rejects.toThrow();
    await expect(session('invalid','admin','z')).rejects.toThrow();
    await expect(sql("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES('short','admin','abc',unixepoch()+1)")).rejects.toThrow();
    await expect(session('past','admin','c',0)).rejects.toThrow();
  });
  it('supports free-form lane and enforces one active raid, closed state and location guards', async () => {
    await raid('raid');
    expect(await db.prepare("SELECT lane FROM raid_sessions WHERE id='raid'").first<string>('lane')).toBe('Jalur Utara A');
    await expect(raid('second')).rejects.toThrow();
    await expect(sql("UPDATE raid_sessions SET status='CLOSED' WHERE id='raid'")).rejects.toThrow();
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
    await expect(sql("UPDATE raid_sessions SET status='ACTIVE',closed_at=NULL WHERE id='raid'")).rejects.toThrow();
    await raid('second');
    await expect(raid('bad-location','other','missing')).rejects.toThrow();
    await sql("UPDATE locations SET is_active=0 WHERE id='location'");
    await expect(raid('inactive','other')).rejects.toThrow();
    await expect(sql("UPDATE raid_sessions SET location_id='missing' WHERE id='second'")).rejects.toThrow();
  });
  it('inactive users cannot open new raids but authorized old snapshots remain eligible', async () => {
    await raid('raid');
    await sql("UPDATE users SET is_active=0 WHERE id='officer'");
    await log('check');
    expect(await db.prepare("SELECT count(*) AS n FROM check_logs WHERE id='check'").first('n')).toBe(1);
    await expect(raid('inactive-officer')).rejects.toThrow('Inactive raid location or user');
    await sql("UPDATE users SET is_active=0 WHERE id='other'");
    await expect(raid('other-raid','other')).rejects.toThrow();
  });
  it('composite FK binds log to raid user and idempotency is per raid only', async () => {
    await raid('raid');
    await log('one');
    await expect(log('wrong-user','raid','other','FOUND','ACTIVE','ACTIVE','LIVE','wrong-user','DH2345ZZ')).rejects.toThrow('FOREIGN KEY');
    await expect(log('missing-raid','missing')).rejects.toThrow();
    await expect(log('two','raid','officer','FOUND','ACTIVE','ACTIVE','LIVE','one','DH3456ZZ')).rejects.toThrow();
    await raid('other-raid','other');
    await log('three','other-raid','other','FOUND','ACTIVE','ACTIVE','CACHE','one');
    // No unapproved history cycle sealing: delayed writes may target a closed raid.
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=unixepoch() WHERE id='raid'");
    await log('delayed','raid','officer','FOUND','UNKNOWN','ACTIVE','LIVE','delayed','DH4567ZZ');
  });
  it('FOUND requires typed statuses; NOT_FOUND requires null statuses and LIVE', async () => {
    await raid('raid');
    await log('found'); await log('absent','raid','officer','NOT_FOUND',null,null,'LIVE','absent','DH2345ZZ');
    await expect(log('null-found','raid','officer','FOUND',null,'ACTIVE','LIVE','null-found','DH3ZZ')).rejects.toThrow('CHECK constraint');
    await expect(log('invalid-status','raid','officer','FOUND','BAD','ACTIVE','LIVE','invalid-status','DH4ZZ')).rejects.toThrow('CHECK constraint');
    await expect(log('not-found-status','raid','officer','NOT_FOUND','UNKNOWN',null,'LIVE','not-found-status','DH5ZZ')).rejects.toThrow('CHECK constraint');
    await expect(log('cached-absence','raid','officer','NOT_FOUND',null,null,'CACHE','cached-absence','DH6ZZ')).rejects.toThrow('CHECK constraint');
    await expect(log('error-outcome','raid','officer','UPSTREAM_ERROR',null,null,'LIVE','error-outcome','DH7ZZ')).rejects.toThrow('CHECK constraint');
  });
  it('restricts historical deletion and validates typed audit actors/targets', async () => {
    await session('auth','officer','a'); await raid('raid'); await log('check');
    await sql("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_session_id) VALUES('audit','admin','SESSION_REVOKED','auth')");
    await expect(sql("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES('bad','officer','USER_UPDATED','other')")).rejects.toThrow('Active admin required');
    await expect(sql("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES('bad','admin','SESSION_REVOKED','other')")).rejects.toThrow();
    await expect(sql("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES('bad','admin','ARBITRARY','other')")).rejects.toThrow();
    await expect(sql("DELETE FROM users WHERE id='officer'")).rejects.toThrow('FOREIGN KEY');
    await expect(sql("DELETE FROM locations WHERE id='location'")).rejects.toThrow('FOREIGN KEY');
    await expect(sql("DELETE FROM raid_sessions WHERE id='raid'")).rejects.toThrow('FOREIGN KEY');
    await expect(sql("DELETE FROM user_sessions WHERE id='auth'")).rejects.toThrow('FOREIGN KEY');
  });
});
