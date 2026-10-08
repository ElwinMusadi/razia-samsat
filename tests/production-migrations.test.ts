import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../scripts/lib';
import { EXPECTED_ACCOUNT, EXPECTED_WORKER } from '../scripts/production-config';
import { assertProductionMigrationTarget, buildMigrationPayload, createScratchMigrationStore, loadMigrationSources, MIGRATION_DATABASE_ID, MIGRATION_METADATA_SQL, normalizeSchemaSql, runMigrations, schemaFingerprint, type CatalogEntry, type MigrationRow, type MigrationState, type MigrationStore, type ScratchTarget } from '../scripts/production-migrations';
import type { CliResult, CliRunner } from '../scripts/production';

const sources = await loadMigrationSources();
const timestamp = '2026-10-08 21:00:00';
function catalog(db: DatabaseSync): CatalogEntry[] { return db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY type,name').all() as CatalogEntry[]; }
function state(db: DatabaseSync): MigrationState {
  const entries = catalog(db);
  return { catalog: entries, migrations: entries.some(entry=>entry.name==='d1_migrations') ? db.prepare('SELECT id,name,applied_at FROM d1_migrations ORDER BY id').all() as MigrationRow[] : [], foreignKeys: Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys), foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all() };
}
function atomic(db: DatabaseSync, sql: string): void {
  // Test-only local transaction models one file ingestion; never added to production payloads.
  db.exec('BEGIN;');
  try { db.exec(sql); db.exec('COMMIT;'); }
  catch(error) { db.exec('ROLLBACK;'); throw error; }
}
async function fixture(test: (value: { db: DatabaseSync; store: MigrationStore; imports: string[]; paths: string[]; notices: string[]; initializations: () => number }) => Promise<void>, prefix = 0, metadata = true): Promise<void> {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON;');
  if(metadata) db.exec(MIGRATION_METADATA_SQL);
  for(const source of sources.slice(0,prefix)) {
    db.exec(source.sql);
    if(metadata) db.prepare('INSERT INTO d1_migrations(name,applied_at) VALUES(?,?)').run(source.filename,timestamp);
  }
  const imports:string[]=[], paths:string[]=[], notices:string[]=[]; let initializations=0;
  const store:MigrationStore={readState:async()=>state(db),initializeMetadata:async()=>{initializations++; db.exec(MIGRATION_METADATA_SQL);},importFile:async file=>{paths.push(file); const sql=await readFile(file,'utf8'); imports.push(sql); atomic(db,sql);} };
  try { await test({db,store,imports,paths,notices,initializations:()=>initializations}); }
  finally { db.close(); }
}
async function files(values: Record<string,string | Buffer>, test: (directory:string)=>Promise<void>): Promise<void> {
  const directory=await mkdtemp(join(tmpdir(),'razia-migration-test-'));
  try { for(const [name,value] of Object.entries(values)) await writeFile(join(directory,name),value); await test(directory); }
  finally { await rm(directory,{recursive:true,force:true}); }
}

 describe('controlled migration file sources and schema tokenizer',()=>{
  it('loads all three authoritative raw files byte-for-byte with SHA-256 evidence',async()=>{
    expect(sources.map(source=>source.filename)).toEqual(['0001_foundation.sql','0002_history.sql','0003_admin.sql']);
    for(const source of sources) {
      expect(Buffer.from(source.sql)).toEqual(await readFile(source.path)); expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(buildMigrationPayload(source)).toBe(`${source.sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${source.filename}');`);
      expect(buildMigrationPayload(source).startsWith(source.sql)).toBe(true);
    }
  });
  it('matches the pinned installed vendor metadata schema and suffix without editing dependencies',async()=>{
    const pkg=JSON.parse(await readFile(join(PROJECT_ROOT,'node_modules/wrangler/package.json'),'utf8'));
    expect(pkg.version).toBe('4.148.0');
    const cli=await readFile(join(PROJECT_ROOT,'node_modules/wrangler/wrangler-dist/cli.js'),'utf8');
    expect(cli).toContain('id         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL');
    expect(cli.includes("values ('${migrationName.replace(/'/g, \"''\")}');")).toBe(true);
  });
  it('allows future numeric gaps and sorts full names',async()=>{
    await files({'0010_future.sql':'CREATE TABLE future(id TEXT);','0001_first.sql':'CREATE TABLE first(id TEXT);'},async directory=>{
      expect((await loadMigrationSources(directory)).map(source=>source.filename)).toEqual(['0001_first.sql','0010_future.sql']);
    });
  });
  it.each(['0000_zero.sql','0001_UPPER.sql','1_short.sql','0001_bad-name.sql','notes.txt'])('rejects invalid filename %s',async name=>{
    await files({[name]:'SELECT 1;'},async directory=>{await expect(loadMigrationSources(directory)).rejects.toThrow();});
  });
  it('rejects duplicate numeric prefixes, empty directories and invalid UTF-8',async()=>{
    const cases:Record<string,string|Buffer>[]=[{'0001_a.sql':'SELECT 1;','0001_b.sql':'SELECT 2;'},{},{'0001_bad.sql':Buffer.from([0xc3,0x28])}];
    for(const values of cases) await files(values,async directory=>{await expect(loadMigrationSources(directory)).rejects.toThrow();});
  });
  it('rejects a junction directory and non-file migration entries',async()=>{
    await files({'0001_ok.sql':'SELECT 1;'},async directory=>{
      const alias=`${directory}-alias`;
      try { await symlink(directory,alias,'junction'); await expect(loadMigrationSources(alias)).rejects.toThrow('Direktori migrasi'); }
      finally { await rm(alias,{force:true}); }
      await rename(join(directory,'0001_ok.sql'),join(directory,'0001_hold.sql'));
      await symlink(directory,join(directory,'0001_link.sql'),'junction');
      await expect(loadMigrationSources(directory)).rejects.toThrow();
    });
  });
  it('normalizes whitespace and comments only outside quoted content',()=>{
    const sql='CREATE TABLE t (value TEXT CHECK(value = \'a  -- /* b\'), " spaced  name " TEXT DEFAULT \'it\'\'s  exact\');';
    expect(normalizeSchemaSql(sql)).toBe(normalizeSchemaSql(`/* note */ CREATE\n TABLE t(value TEXT CHECK ( value= 'a  -- /* b'), " spaced  name " TEXT DEFAULT 'it''s  exact'); -- tail`));
    expect(normalizeSchemaSql(sql)).not.toBe(normalizeSchemaSql(sql.replace('a  --','a --')));
    expect(normalizeSchemaSql(sql)).not.toBe(normalizeSchemaSql(sql.replace(' spaced  name ',' spaced name ')));
    expect(normalizeSchemaSql('x <= y')).not.toBe(normalizeSchemaSql('x < = y'));
    expect(normalizeSchemaSql('CREATE TABLE "t"(id TEXT)')).not.toBe(normalizeSchemaSql('CREATE TABLE t(id TEXT)'));
  });
  it.each(["SELECT 'unfinished",'SELECT /* unfinished'])('rejects incomplete schema lexical input %s',sql=>{expect(()=>normalizeSchemaSql(sql)).toThrow();});
  it('rejects altered source checksums or unsafe names before producing metadata SQL',()=>{
    expect(()=>buildMigrationPayload({...sources[0],sql:'SELECT 1;'})).toThrow();
    expect(()=>buildMigrationPayload({...sources[0],filename:"0001_x');--.sql"})).toThrow();
  });
 });

 describe('migration state machine with actual local SQLite schemas',()=>{
  it('initializes only an empty database, imports exact whole files, verifies and cleans up',async()=>{
    await fixture(async({db,store,imports,paths,notices,initializations})=>{
      await runMigrations(store,{notice:message=>notices.push(message)});
      expect(initializations()).toBe(1); expect(imports).toEqual(sources.map(buildMigrationPayload));
      expect(state(db).migrations.map(row=>row.name)).toEqual(sources.map(source=>source.filename));
      expect(state(db).foreignKeyViolations).toEqual([]);
      expect(catalog(db).filter(entry=>entry.type==='table'&&!entry.name.startsWith('sqlite_')&&entry.name!=='d1_migrations')).toHaveLength(6);
      expect(notices).toHaveLength(3); expect(notices[0]).toContain(sources[0].sha256);
      for(const path of paths) await expect(readFile(path)).rejects.toThrow();
    },0,false);
  });
  it.each([0,1,2,3])('resumes valid prefix %s and a second run performs no writes',async prefix=>{
    await fixture(async({store,imports,initializations})=>{
      await runMigrations(store); expect(imports).toEqual(sources.slice(prefix).map(buildMigrationPayload)); expect(initializations()).toBe(0);
      const count=imports.length; await runMigrations(store); expect(imports).toHaveLength(count);
    },prefix);
  });
  it('allows increasing positive metadata IDs with gaps',async()=>{
    await fixture(async({db,store,imports})=>{ db.exec('UPDATE d1_migrations SET id=id+10;'); await runMigrations(store); expect(imports).toHaveLength(1); },2);
  });
  it('refuses application schema without metadata and never initializes a marker',async()=>{
    await fixture(async({store,imports,initializations})=>{await expect(runMigrations(store)).rejects.toThrow(); expect(imports).toEqual([]); expect(initializations()).toBe(0);},1,false);
  });
  it('refuses existing empty metadata paired with already-created application tables',async()=>{
    await fixture(async({db,store,imports})=>{ db.exec(sources[0].sql); await expect(runMigrations(store)).rejects.toThrow('prefix metadata'); expect(imports).toEqual([]); });
  });
  it.each(['unknown','gap','duplicate','reverse','bad-id','bad-timestamp'])('refuses malformed history %s without mutation',async mode=>{
    await fixture(async({store,imports})=>{
      const read=store.readState; store.readState=async()=>{
        const value=await read();
        if(mode==='unknown') value.migrations[0].name='0001_unknown.sql';
        if(mode==='gap') value.migrations.splice(0,1);
        if(mode==='duplicate') value.migrations[1].name=value.migrations[0].name;
        if(mode==='reverse') value.migrations.reverse();
        if(mode==='bad-id') value.migrations[0].id=0;
        if(mode==='bad-timestamp') value.migrations[0].applied_at='';
        return value;
      };
      await expect(runMigrations(store)).rejects.toThrow(); expect(imports).toEqual([]);
    },2);
  });
   it.each(['2026-02-29 21:00:00','2024-02-30 21:00:00','2026-04-31 21:00:00','2026-10-08 24:00:00','2026-10-08 21:60:00','2026-10-08 21:00:60'])('refuses an impossible metadata calendar timestamp %s before mutation',async appliedAt=>{
     await fixture(async({db,store,imports})=>{
       db.prepare('UPDATE d1_migrations SET applied_at=?').run(appliedAt);
       await expect(runMigrations(store)).rejects.toThrow('Metadata migrasi'); expect(imports).toEqual([]);
     },1);
   });
   it('accepts a valid leap-day UTC timestamp and reports an already-applied prefix',async()=>{
     await fixture(async({db,store,imports,notices})=>{
       db.prepare('UPDATE d1_migrations SET applied_at=?').run('2024-02-29 23:59:59');
       await runMigrations(store,{notice:message=>notices.push(message)});
       expect(imports).toHaveLength(0); expect(notices).toEqual(['Terverifikasi 3 migrasi sudah diterapkan; prefix yang cocok tidak diimpor ulang.']);
     },3);
   });
   it.each(['metadata','table','index','trigger','ghost','internal'])('refuses schema drift in %s',async mode=>{
    await fixture(async({db,store,imports})=>{
      if(mode==='metadata') db.exec('ALTER TABLE d1_migrations ADD COLUMN checksum TEXT;');
      if(mode==='table') db.exec('ALTER TABLE users ADD COLUMN shadow TEXT;');
      if(mode==='index') db.exec('DROP INDEX check_logs_raid_checked_id; CREATE INDEX check_logs_raid_checked_id ON check_logs(raid_session_id,checked_at ASC,id DESC);');
      if(mode==='trigger') db.exec("DROP TRIGGER check_logs_immutable; CREATE TRIGGER check_logs_immutable BEFORE UPDATE ON check_logs BEGIN SELECT RAISE(ABORT,'Changed policy'); END;");
      if(mode==='ghost') db.exec('CREATE TABLE admin_audit_logs_new(id TEXT);');
      if(mode==='internal') db.exec('CREATE TABLE _cf_unknown(id TEXT);');
      await expect(runMigrations(store)).rejects.toThrow(); expect(imports).toEqual([]);
    },2);
  });
  it('refuses disabled foreign keys or FK violations',async()=>{
    await fixture(async({db,store,imports})=>{ db.exec('PRAGMA foreign_keys=OFF;'); await expect(runMigrations(store)).rejects.toThrow('FK'); expect(imports).toEqual([]); },1);
    await fixture(async({store,imports})=>{ const read=store.readState; store.readState=async()=>({...await read(),foreignKeyViolations:[{table:'users'}]}); await expect(runMigrations(store)).rejects.toThrow('FK'); expect(imports).toEqual([]); },1);
  });
  it('retains the old complete prefix when metadata insertion fails after all pending DDL',async()=>{
    await fixture(async({db,store,imports,paths})=>{
      const before=state(db), original=store.importFile;
      store.importFile=async file=>{
        paths.push(file); const payload=await readFile(file,'utf8'); imports.push(payload);
        atomic(db,payload.replace("values ('0002_history.sql');","values ('0001_foundation.sql');"));
      };
      await expect(runMigrations(store)).rejects.toThrow('prefix teramati=1');
      expect(state(db)).toEqual(before); expect(imports).toHaveLength(1);
      for(const path of paths) await expect(readFile(path)).rejects.toThrow();
      store.importFile=original; await runMigrations(store); expect(state(db).migrations).toHaveLength(3);
    },1);
  });
  it('rolls back first-file DDL when its metadata table is missing in a local atomic ingestion',async()=>{
    await fixture(async({db})=>{
      expect(()=>atomic(db,buildMigrationPayload(sources[0]))).toThrow(); expect(catalog(db)).toEqual([]);
    },0,false);
  });
  it('stops on a lost response after commit, then a deliberate rerun reconciles without replay',async()=>{
    await fixture(async({db,store,imports})=>{
      const original=store.importFile; store.importFile=async file=>{await original(file); throw new Error('secret diagnostic');};
      await expect(runMigrations(store)).rejects.toThrow('prefix teramati=1'); expect(imports).toHaveLength(1); expect(state(db).migrations).toHaveLength(1);
      store.importFile=original; await runMigrations(store); expect(imports).toEqual(sources.map(buildMigrationPayload));
    });
  });
  it('requires post-import metadata and schema instead of trusting a successful return',async()=>{
    await fixture(async({store})=>{store.importFile=async()=>{}; await expect(runMigrations(store)).rejects.toThrow('Impor tidak terkonfirmasi');});
  });
  it('rejects concurrent prefix changes before an import',async()=>{
    await fixture(async({db,store,imports})=>{ const read=store.readState; let reads=0; store.readState=async()=>{if(++reads===2) atomic(db,buildMigrationPayload(sources[0])); return read();}; await expect(runMigrations(store)).rejects.toThrow('berubah bersamaan'); expect(imports).toEqual([]); });
  });
  it('rejects invalid local replay before reading or writing the store',async()=>{
    await files({'0001_invalid.sql':'CREATE TRIGGER broken;'},async directory=>{
      let calls=0; const store:MigrationStore={readState:async()=>{calls++; throw new Error('unexpected');},initializeMetadata:async()=>{calls++;},importFile:async()=>{calls++;}};
      await expect(runMigrations(store,{directory})).rejects.toThrow('Replay'); expect(calls).toBe(0);
    });
  });
  it('detects source edits before and after import and never retries',async()=>{
    for(const phase of ['before','after']) await files({'0001_first.sql':'CREATE TABLE first(id TEXT);'},async directory=>{
      await fixture(async({store,imports})=>{
        const read=store.readState, original=store.importFile; let reads=0;
        if(phase==='before') store.readState=async()=>{const value=await read(); if(++reads===1) await writeFile(join(directory,'0001_first.sql'),'CREATE TABLE changed(id TEXT);'); return value;};
        else store.importFile=async file=>{await original(file); await writeFile(join(directory,'0001_first.sql'),'CREATE TABLE changed(id TEXT);');};
        await expect(runMigrations(store,{directory})).rejects.toThrow('Checksum'); expect(imports).toHaveLength(phase==='before'?0:1);
      });
    });
  });
  it('ignores known D1 internal storage and rejects duplicate catalog names',()=>{
    const app=catalogForSource();
    expect(schemaFingerprint([...app,{name:'_cf_KV',type:'table',sql:'CREATE TABLE _cf_KV(key TEXT)'}])).toBe(schemaFingerprint(app));
    expect(()=>schemaFingerprint([...app,app[0]])).toThrow('duplikat');
  });
 });
function catalogForSource(): CatalogEntry[] { const db=new DatabaseSync(':memory:'); try{db.exec(sources[0].sql); return catalog(db);} finally{db.close();} }

const scratch = ():ScratchTarget=>({scope:'scratch',account:EXPECTED_ACCOUNT,database:'74fa3a64-7afc-416c-873d-543af067ad0f',databaseName:'razia-samsat-migration-design-deadbeef'});
const output=(value:unknown):CliResult=>({status:0,stdout:JSON.stringify(value),stderr:''});
 describe('scoped CLI protocol, entirely injected and local',()=>{
  it.each([
    {database:MIGRATION_DATABASE_ID},{database:'bad'},{databaseName:'razia-samsat-db'},{account:'a'.repeat(32)},{scope:'production'},
  ])('rejects non-scratch targets before any CLI %#',change=>{
    expect(()=>createScratchMigrationStore({...scratch(),...change} as ScratchTarget,async()=>{throw new Error('must not execute');})).toThrow('Target scratch');
  });
  it('rejects any non-final production target locally',()=>{
    const target={account:EXPECTED_ACCOUNT,worker:EXPECTED_WORKER,database:MIGRATION_DATABASE_ID,namespace:'a'.repeat(32),hostname:'tilang.uptdpenda-kupang.web.id',origin:'https://tilang.uptdpenda-kupang.web.id',zone:'b'.repeat(32),passwordIterations:10};
    expect(()=>assertProductionMigrationTarget(target)).not.toThrow();
    for(const change of [{database:scratch().database},{account:'a'.repeat(32)},{worker:'other'}]) expect(()=>assertProductionMigrationTarget({...target,...change})).toThrow();
  });
  it('uses only fixed read SQL, official list initialization and one --file ingestion per migration',async()=>{
    await fixture(async({db})=>{
      const calls:string[][][]=[], paths:string[]=[];
      const run:CliRunner=async args=>{
         calls.push([args]); expect(args).toContain('--remote');
         if(args[1]==='migrations') {
           expect(args[3]).toBe(scratch().databaseName);
           expect(args).toEqual(['d1','migrations','list',scratch().databaseName,'--remote']);
           db.exec(MIGRATION_METADATA_SQL); return output([]);
         }
         expect(args[1]).toBe('execute'); expect(args[2]).toBe(scratch().database);
        if(args.includes('--file')) {const path=args[args.indexOf('--file')+1]; paths.push(path); expect(args).toEqual(['d1','execute',scratch().database,'--remote','--file',path,'--json','--yes']); atomic(db,await readFile(path,'utf8')); return {status:0,stdout:'upload progress before JSON',stderr:''};}
        const current=state(db), query=args[args.indexOf('--command')+1]; expect(query).not.toMatch(/INSERT|CREATE|DROP|UPDATE|DELETE/);
        const rows=query.includes('SELECT id,name,applied_at') ? [current.catalog,current.migrations,current.foreignKeyViolations,[{foreign_keys:1}]] : query.includes('PRAGMA') ? [current.catalog,current.foreignKeyViolations,[{foreign_keys:1}]] : [current.catalog];
        return output(rows.map(results=>({success:true,results})));
      };
      await runMigrations(createScratchMigrationStore(scratch(),run));
      expect(paths).toHaveLength(3); expect(calls.flat().some(args=>args.includes('apply'))).toBe(false);
      expect(state(db).migrations).toHaveLength(3); for(const path of paths) await expect(readFile(path)).rejects.toThrow();
    },0,false);
  });
  it.each([
    {status:1,stdout:'secret',stderr:'secret'}, {status:null,stdout:'secret',stderr:'secret'}, output('malformed'), output([{success:false,results:[]}]), output([{success:true,results:[]},{success:true,results:[]}]), output([{success:true,results:[null]}]),
  ])('rejects invalid CLI reads without returning raw diagnostics %#',async result=>{
    await expect(createScratchMigrationStore(scratch(),async()=>result).readState()).rejects.toThrow();
    try{await createScratchMigrationStore(scratch(),async()=>result).readState();}catch(error){expect(String(error)).not.toContain('secret');}
  });
  it('checks the scratch scope again before each IO',async()=>{
    const target=scratch(); const store=createScratchMigrationStore(target,async()=>output([{success:true,results:[]}])); target.database=MIGRATION_DATABASE_ID;
    await expect(store.readState()).rejects.toThrow('Target scratch');
  });
 });
