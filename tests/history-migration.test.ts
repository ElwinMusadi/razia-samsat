import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTestMigrations, loadMigrationFiles, resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

let mf: Miniflare, db: TestD1;
const fields = ['id','raid_session_id','user_id','idempotency_key','nopol','outcome','tax_status','stnk_status','source','checked_at'];
async function seed(database: TestD1) {
  await database.batch([
    database.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('user','synthetic.user','unused','OFFICER'),('other','synthetic.other','unused','OFFICER')"),
    database.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')"),
    database.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane,status,started_at,closed_at) VALUES('raid','user','location','A','CLOSED',100,200)"),
  ]);
}
function insert(database: TestD1, id = 'check', nopol = 'DH1ZZ', user = 'user', raid = 'raid', key = id) {
  return database.prepare(`INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,tax_status,stnk_status,source,checked_at)
    VALUES(?,?,?,?,?,'FOUND','UNKNOWN','EXPIRED','CACHE',123)`).bind(id,raid,user,key,nopol).run();
}
beforeAll(async () => { ({mf,db} = await startMigratedD1()); });
beforeEach(async () => { await resetTestD1(db); await seed(db); });
afterAll(async () => { await mf?.dispose(); });

describe('authoritative ordered atomic migration files on actual D1/workerd', () => {
  it('loads all SQL files lexicographically and keeps full triggers intact', async () => {
    const files = await loadMigrationFiles();
    expect(files.map(f=>f.filename)).toEqual(['0001_foundation.sql','0002_history.sql','0003_admin.sql']);
    expect((await loadMigrationFiles('0001_foundation.sql')).map(f=>f.filename)).toEqual(['0001_foundation.sql']);
    expect(files[1].statements[0]).toBe('CREATE UNIQUE INDEX check_logs_raid_nopol ON check_logs(raid_session_id, nopol);');
    expect(files[1].statements.find(s=>s.startsWith('CREATE TRIGGER'))).toBe("CREATE TRIGGER check_logs_immutable BEFORE UPDATE ON check_logs BEGIN SELECT RAISE(ABORT, 'Check log is immutable'); END;");
    await expect(loadMigrationFiles('missing.sql')).rejects.toThrow('Unknown migration filename');
  });
  it('fresh schema retains ten fields, technical unique, FKs and correct paging indexes', async () => {
    expect((await db.prepare('PRAGMA table_info(check_logs)').all<{name:string}>()).results.map((r:{name:string})=>r.name)).toEqual(fields);
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all<{name:string}>()).results.map((r:{name:string})=>r.name);
    expect(indexes).toEqual(expect.arrayContaining(['check_logs_raid_nopol','check_logs_raid_checked_id','check_logs_user_time','raid_sessions_user_started_id','raid_sessions_started_id']));
    expect(indexes).not.toContain('check_logs_raid_time');
    for (const [index,columns] of [['check_logs_raid_checked_id',['raid_session_id','checked_at','id']],['raid_sessions_user_started_id',['user_id','started_at','id']],['raid_sessions_started_id',['started_at','id']]] as const) {
      const info: {name:string;desc:number;key:number}[] = (await db.prepare(`PRAGMA index_xinfo(${index})`).all<{name:string;desc:number;key:number}>()).results.filter((r:{key:number})=>r.key);
      expect(info.map(r=>r.name)).toEqual(columns);
      expect(info.slice(-2).map(r=>r.desc)).toEqual([1,1]);
    }
    const fk: {table:string;on_delete:string}[] = (await db.prepare('PRAGMA foreign_key_list(check_logs)').all<{table:string;on_delete:string}>()).results;
    expect(fk).toHaveLength(3); expect(fk.every(r=>r.on_delete==='RESTRICT')).toBe(true);
    expect(fk.map(r=>r.table).sort()).toEqual(['raid_sessions','raid_sessions','users']);
  });
  it('every UPDATE including no-op is rejected; deletion is not silently performed or permanently blocked', async () => {
    await insert(db); const original = await db.prepare('SELECT * FROM check_logs').first();
    for (const set of ["id=id", "nopol='DH2ZZ'", "tax_status='ACTIVE'", 'checked_at=999', "source='LIVE'", "outcome='NOT_FOUND',tax_status=NULL,stnk_status=NULL,source='LIVE'"]) {
      await expect(db.prepare(`UPDATE check_logs SET ${set}`).run()).rejects.toThrow('Check log is immutable');
      expect(await db.prepare('SELECT * FROM check_logs').first()).toEqual(original);
    }
    await db.prepare("DELETE FROM check_logs WHERE id='check'").run();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM check_logs').first('n')).toBe(0);
  });
  it('delayed closed-raid insertion survives inactive owner but ownership/existence FKs still reject', async () => {
    await db.prepare("UPDATE users SET is_active=0 WHERE id='user'").run(); await insert(db);
    await expect(insert(db,'missing-user','DH2ZZ','missing')).rejects.toThrow('FOREIGN KEY');
    await expect(insert(db,'wrong-owner','DH3ZZ','other')).rejects.toThrow('FOREIGN KEY');
    await expect(insert(db,'missing-raid','DH4ZZ','user','missing')).rejects.toThrow('FOREIGN KEY');
    await expect(db.prepare("DELETE FROM users WHERE id='user'").run()).rejects.toThrow('FOREIGN KEY');
    await expect(db.prepare("DELETE FROM raid_sessions WHERE id='raid'").run()).rejects.toThrow('FOREIGN KEY');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM check_logs').first('n')).toBe(1);
  });
  it('only business-key duplicate is a no-op, technical key and primary key conflicts remain errors', async () => {
    await insert(db);
    const duplicate = await db.prepare(`INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source,checked_at)
      VALUES('second','raid','user','second','DH1ZZ','NOT_FOUND','LIVE',999) ON CONFLICT(raid_session_id,nopol) DO NOTHING`).run();
    expect(duplicate.meta.changes).toBe(0);
    await expect(insert(db,'check','DH2ZZ')).rejects.toThrow('UNIQUE');
    await expect(insert(db,'second','DH3ZZ','user','raid','check')).rejects.toThrow('UNIQUE');
    expect(await db.prepare('SELECT checked_at FROM check_logs').first('checked_at')).toBe(123);
  });
  it.each(['compatible','duplicates'] as const)('populated 0001 upgrade: %s data is preserved with fail-closed atomic boundary', async kind => {
    const baseline = await startMigratedD1(undefined,'0001_foundation.sql');
    try {
      await seed(baseline.db); await insert(baseline.db,'first');
      await insert(baseline.db,'second',kind==='duplicates'?'DH1ZZ':'DH2ZZ');
      await baseline.db.prepare("INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source,checked_at) VALUES('absence','raid','user','absence','DH3ZZ','NOT_FOUND','LIVE',222)").run();
      const original = (await baseline.db.prepare('SELECT * FROM check_logs ORDER BY id').all()).results;
      const schema = (await baseline.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
      if (kind==='duplicates') {
        await expect(applyTestMigrations(baseline.db,undefined,'0001_foundation.sql')).rejects.toThrow('UNIQUE');
        expect((await baseline.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results).toEqual(schema);
        expect(await baseline.db.prepare("SELECT name FROM sqlite_master WHERE name='check_logs_active_user'").first('name')).toBe('check_logs_active_user');
        await baseline.db.prepare("UPDATE users SET is_active=0 WHERE id='user'").run();
        await expect(insert(baseline.db,'late','DH4ZZ')).rejects.toThrow('Inactive check user');
      } else {
        await applyTestMigrations(baseline.db,undefined,'0001_foundation.sql');
        expect(await baseline.db.prepare("SELECT name FROM sqlite_master WHERE name='check_logs_active_user'").first()).toBeNull();
        await expect(baseline.db.prepare('UPDATE check_logs SET id=id').run()).rejects.toThrow('Check log is immutable');
        expect((await baseline.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      }
      expect((await baseline.db.prepare('SELECT * FROM check_logs ORDER BY id').all()).results).toEqual(original);
      expect(original).toHaveLength(3);
    } finally { await baseline.mf.dispose(); }
  });
});
