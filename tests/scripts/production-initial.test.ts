import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { PROJECT_ROOT } from '../../scripts/lib';
import { hashPassword, parsePasswordHash, verifyPassword } from '../../shared/password';
import { validateProductionConfig } from '../../scripts/production-config';
import { MIGRATION_METADATA_SQL, verifyAppliedMigrations, type MigrationState, type MigrationStore } from '../../scripts/production-migrations';
import { INITIAL_ADMIN, INITIAL_OFFICER, INITIAL_LOCATION, INITIAL_SNAPSHOT_SQL, InitialBootstrapError, runInitialBootstrap, runInitialCommand, createInitialCliStore, validateInitialSnapshot, type BootstrapStore, type InitialSnapshot, type InitialDependencies } from '../../scripts/production-initial';
import type { CliRunner } from '../../scripts/production';

const ADMIN_PASSWORD = 'Synthetic-admin-only-123';
const OFFICER_PASSWORD = 'Synthetic-officer-only-456';
const names = (await readdir(join(PROJECT_ROOT, 'migrations'))).sort();
const sqls = await Promise.all(names.map(name => readFile(join(PROJECT_ROOT,'migrations',name),'utf8')));
const rawConfig = experimental_readRawConfig({ config: join(PROJECT_ROOT,'wrangler.production.example.jsonc') }).rawConfig;
// Use a typed explicit fixture rather than reading operator configuration or credentials.
const target = validateProductionConfig({ ...rawConfig, d1_databases:[{binding:'DB',database_name:'razia-samsat-db',database_id:'6fd6706b-5e09-4b54-aef7-c49a82b38bd1',migrations_dir:'migrations'}], kv_namespaces:[{binding:'VEHICLE_CACHE',id:'c8ca3a5faf9c4922a6f3f88aaa7ddbb7'}], routes:[{pattern:'tilang.uptdpenda-kupang.web.id',zone_id:'e937dc955107f12dae6cc95d6f84e2a0',custom_domain:true}] });
const flags = ['--confirm-account',target.account,'--confirm-database',target.database,'--confirm-worker',target.worker,'--confirm-origin',target.origin];
async function fixture(test: (value: {db:DatabaseSync;store:BootstrapStore;writes:string[];notices:string[];password:(label:string)=>Promise<string>})=>Promise<void>):Promise<void> {
  const db=new DatabaseSync(':memory:'); db.exec(MIGRATION_METADATA_SQL);
  for(let i=0;i<sqls.length;i++){db.exec(sqls[i]);db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(names[i]);}
  const writes:string[]=[], notices:string[]=[];
  const schemaState=():MigrationState=>({catalog:db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY type,name').all() as MigrationState['catalog'],migrations:db.prepare('SELECT id,name,applied_at FROM d1_migrations ORDER BY id').all() as MigrationState['migrations'],foreignKeys:Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys),foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all()});
  const store:BootstrapStore={
    verifySchema:async()=>verifyAppliedMigrations({readState:async()=>schemaState()}),
    readSnapshot:async()=>JSON.parse(String(db.prepare(INITIAL_SNAPSHOT_SQL).get()!.state)) as InitialSnapshot,
    write:async sql=>{writes.push(sql);db.exec('BEGIN');try{db.exec(sql);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}},
  };
  try{await test({db,store,writes,notices,password:async label=>label.includes('ADMIN')?ADMIN_PASSWORD:OFFICER_PASSWORD});}finally{db.close();}
}
const apply = (store:BootstrapStore,password:(label:string)=>Promise<string>,notice:(message:string)=>void=()=>{})=>runInitialBootstrap(store,{mode:'apply',passwordIterations:10,readPassword:password,notice});

 describe('initial bootstrap actual isolated schema and per-object atomic writes',()=>{
  it('preflight is read-only, does not request passwords and exposes only safe pending state',async()=>fixture(async({store,writes,notices})=>{
    expect(await runInitialBootstrap(store,{mode:'preflight',passwordIterations:10,readPassword:async()=>{throw new Error('must not read');},notice:m=>notices.push(m)})).toEqual({admin:'pending',officer:'pending',location:'pending'});
    expect(writes).toEqual([]);expect(notices.join(' ')).not.toContain('password_hash');
  }));
  it('creates three exact objects and three audits, verifies configured hashing, leaves no sessions and preserves FK',async()=>fixture(async({db,store,writes,password,notices})=>{
    expect(await apply(store,password,m=>notices.push(m))).toEqual({admin:'created',officer:'created',location:'created'});
    expect(writes).toHaveLength(3);
    const s=await store.readSnapshot();validateInitialSnapshot(s);
    expect(s.users.map(u=>[u.username,u.role,u.is_active])).toEqual([[INITIAL_ADMIN,'ADMIN',1],[INITIAL_OFFICER,'OFFICER',1]]);
    expect(s.locations.map(l=>[l.name,l.is_active])).toEqual([[INITIAL_LOCATION,1]]);
    expect(s.audits.map(a=>a.action).sort()).toEqual(['LOCATION_CREATED','USER_CREATED','USER_CREATED']);
    for(const u of s.users){expect(parsePasswordHash(u.password_hash)?.iterations).toBe(10);expect((await verifyPassword(u.role==='ADMIN'?ADMIN_PASSWORD:OFFICER_PASSWORD,u.password_hash)).ok).toBe(true);expect(writes.join(' ')).not.toContain(u.role==='ADMIN'?ADMIN_PASSWORD:OFFICER_PASSWORD);expect(notices.join(' ')).not.toContain(u.password_hash);}
    expect([s.sessionsCount,s.raidsCount,s.checksCount]).toEqual([0,0,0]);expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }));
  it('repeated apply is a verified no-op without prompts, resets, updates or duplicate audit',async()=>fixture(async({store,writes,password})=>{
    await apply(store,password);const before=await store.readSnapshot();const count=writes.length;
    expect(await apply(store,async()=>{throw new Error('must not read');})).toEqual({admin:'verified-existing',officer:'verified-existing',location:'verified-existing'});
    expect(await store.readSnapshot()).toEqual(before);expect(writes).toHaveLength(count);
  }));
  it('resumes an existing ADMIN without changing its hash or role',async()=>fixture(async({db,store,writes})=>{
    const hash=await hashPassword('Synthetic-existing-admin',100000);db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)').run(randomUUID(),INITIAL_ADMIN,hash,'ADMIN');
    const actor=String(db.prepare('SELECT id FROM users WHERE username=?').get(INITIAL_ADMIN)!.id);
    db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES(?,?,'USER_CREATED',?)").run(randomUUID(),actor,actor);
    const labels:string[]=[];await apply(store,async label=>{labels.push(label);return OFFICER_PASSWORD;});
    expect(labels).toHaveLength(1);expect(labels[0]).toContain('OFFICER');expect((await store.readSnapshot()).users[0].password_hash).toBe(hash);expect(writes).toHaveLength(2);
  }));
  it.each(['same','empty','oversize','cancel'])('rejects invalid or interrupted input before any write: %s',async mode=>fixture(async({store,writes})=>{
    await expect(apply(store,async label=>{if(mode==='cancel'&&label.includes('OFFICER'))throw new Error('cancelled');return mode==='same'?'Synthetic-same':mode==='empty'?'':mode==='oversize'?'x'.repeat(1025):ADMIN_PASSWORD;})).rejects.toThrow();expect(writes).toEqual([]);
  }));
  it.each(['unknown','wrong-role','inactive','bad-hash','officer-only'])('refuses account conflict without changing data: %s',async mode=>fixture(async({db,store,writes,password})=>{
    const username=mode==='unknown'?'synthetic.unknown':mode==='officer-only'?INITIAL_OFFICER:INITIAL_ADMIN;
    db.prepare('INSERT INTO users(id,username,password_hash,role,is_active) VALUES(?,?,?,?,?)').run(randomUUID(),username,mode==='bad-hash'?'corrupt':await hashPassword('Synthetic-existing',10),mode==='wrong-role'||mode==='officer-only'?'OFFICER':'ADMIN',mode==='inactive'?0:1);
    const before=await store.readSnapshot();await expect(apply(store,password)).rejects.toThrow();expect(await store.readSnapshot()).toEqual(before);expect(writes).toEqual([]);
  }));
  it.each(['duplicate','inactive','unknown'])('refuses location conflict without mutation: %s',async mode=>fixture(async({db,store,writes,password})=>{
    db.prepare('INSERT INTO locations(id,name,is_active) VALUES(?,?,?)').run(randomUUID(),mode==='unknown'?'Synthetic other':INITIAL_LOCATION,mode==='inactive'?0:1);
    if(mode==='duplicate')db.prepare('INSERT INTO locations(id,name) VALUES(?,?)').run(randomUUID(),INITIAL_LOCATION);
    await expect(apply(store,password)).rejects.toThrow();expect(writes).toEqual([]);
  }));
  it('refuses a matching existing account without its creation audit, never backfilling',async()=>fixture(async({db,store,writes,password})=>{
    db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)').run(randomUUID(),INITIAL_ADMIN,await hashPassword('Synthetic-existing-no-audit',10),'ADMIN');
    await expect(apply(store,password)).rejects.toThrow('audit penciptaan');expect(writes).toEqual([]);
  }));
  it('refuses a matching existing location without its creation audit',async()=>fixture(async({db,store,writes,password})=>{
    await apply(store,password);db.exec("DELETE FROM admin_audit_logs WHERE action='LOCATION_CREATED'");const before=writes.length;
    await expect(apply(store,password)).rejects.toThrow('audit penciptaan');expect(writes).toHaveLength(before);
  }));
  it('refuses incomplete schema and does not initialize or apply migrations',async()=>fixture(async({db,store,writes,password})=>{
    db.exec('DROP INDEX check_logs_raid_nopol');await expect(apply(store,password)).rejects.toThrow();expect(writes).toEqual([]);
  }));
  it('rolls back OFFICER plus audit failure while reporting verified ADMIN partial state and safely resumes',async()=>fixture(async({store,writes,password})=>{
    const original=store.write;store.write=async sql=>original(sql.includes(`'${INITIAL_OFFICER}'`)?sql+"\nINSERT INTO missing_audit(id) VALUES('synthetic');":sql);
    let error:unknown;try{await apply(store,password);}catch(e){error=e;}
    expect(error).toBeInstanceOf(InitialBootstrapError);expect((error as InitialBootstrapError).progress).toEqual({admin:'created',officer:'pending',location:'pending'});
    expect((await store.readSnapshot()).users).toHaveLength(1);expect((await store.readSnapshot()).audits).toHaveLength(1);
    store.write=original;await apply(store,password);expect((await store.readSnapshot()).users).toHaveLength(2);expect((await store.readSnapshot()).locations).toHaveLength(1);expect(writes.length).toBeGreaterThan(3);
  }));
  it('reports a lost response after commit without replay, allowing verified manual resume',async()=>fixture(async({store,writes,password})=>{
    const original=store.write;store.write=async sql=>{await original(sql);throw new Error('Synthetic lost response');};
    await expect(apply(store,password)).rejects.toMatchObject({progress:{admin:'created',officer:'pending',location:'pending'}});expect(writes).toHaveLength(1);
    store.write=original;await apply(store,password);expect(writes).toHaveLength(3);
  }));
  it('does not attribute a concurrently-created matching account to this invocation',async()=>fixture(async({db,store,password})=>{
    store.write=async()=>{const otherId=randomUUID();db.prepare('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)').run(otherId,INITIAL_ADMIN,await hashPassword('Synthetic-other-operator',10),'ADMIN');db.prepare("INSERT INTO admin_audit_logs(id,actor_user_id,action,target_user_id) VALUES(?,?,'USER_CREATED',?)").run(randomUUID(),otherId,otherId);throw new Error('Synthetic conflict');};
    await expect(apply(store,password)).rejects.toMatchObject({progress:{admin:'unknown',officer:'pending',location:'pending'}});
  }));
  it('marks unobservable remote result unknown, without leaking underlying diagnostics',async()=>fixture(async({store,password})=>{
    const read=store.readSnapshot;let inaccessible=false;store.readSnapshot=async()=>{if(inaccessible)throw new Error(ADMIN_PASSWORD);return read();};store.write=async()=>{inaccessible=true;throw new Error(OFFICER_PASSWORD);};
    let message='';try{await apply(store,password);}catch(e){message=String(e);expect((e as InitialBootstrapError).progress.admin).toBe('unknown');}
    expect(message).not.toContain(ADMIN_PASSWORD);expect(message).not.toContain(OFFICER_PASSWORD);
  }));
 });

function dependencies(store:BootstrapStore):{deps:InitialDependencies;calls:string[][];notices:string[];passwordReads:()=>number} {
  const calls:string[][]=[],notices:string[]=[];let reads=0;
  const deps:InitialDependencies={load:()=>target,isTTY:()=>true,notice:m=>notices.push(m),store:()=>store,password:async label=>{reads++;return label.includes('ADMIN')?ADMIN_PASSWORD:OFFICER_PASSWORD;},run:async args=>{calls.push(args);return {status:0,stderr:'',stdout:JSON.stringify(args[0]==='whoami'?{loggedIn:true,accounts:[{id:target.account}]}:args[0]==='kv'?[{id:target.namespace,title:'razia-samsat-vehicle-cache'}]:[{uuid:target.database,name:'razia-samsat-db'}])};}};
  return {deps,calls,notices,passwordReads:()=>reads};
}
 describe('operator CLI flags, terminal boundary and fail-closed targets',()=>{
  it('preflight verifies inventory and displays target before returning pending plan, with no password input',async()=>fixture(async({store,writes})=>{
    const {deps,calls,notices,passwordReads}=dependencies(store);await runInitialCommand(['preflight',...flags],deps);
    expect(calls).toHaveLength(3);expect(passwordReads()).toBe(0);expect(writes).toEqual([]);expect(notices[0]).toContain(target.database);
  }));
  it('apply requires explicit set approval and real TTY before mutations',async()=>fixture(async({store,writes})=>{
    const {deps}=dependencies(store);await expect(runInitialCommand(['apply',...flags],deps)).rejects.toThrow('Konfirmasi objek');
    deps.isTTY=()=>false;await expect(runInitialCommand(['apply',...flags,'--confirm-initial-objects','initial-accounts-and-location'],deps)).rejects.toThrow('terminal interaktif');expect(writes).toEqual([]);
  }));
  it.each(['password','role','username','location','token'])('rejects forbidden CLI field %s before inventory/input',async field=>fixture(async({store})=>{
    const {deps,calls,passwordReads}=dependencies(store);await expect(runInitialCommand(['apply',...flags,`--${field}`,'synthetic'],deps)).rejects.toThrow();expect(calls).toEqual([]);expect(passwordReads()).toBe(0);
  }));
  it.each(['account','database','worker','origin'])('rejects wrong explicit confirmation %s',async field=>fixture(async({store})=>{
    const {deps,calls}=dependencies(store),args=[...flags];args[args.indexOf(`--confirm-${field}`)+1]='synthetic-wrong';await expect(runInitialCommand(['preflight',...args],deps)).rejects.toThrow();expect(calls).toEqual([]);
  }));
  it('rejects account/database target mismatch and missing resource inventory',async()=>fixture(async({store,writes})=>{
    const {deps,calls}=dependencies(store);deps.load=()=>({...target,database:randomUUID()});await expect(runInitialCommand(['preflight',...flags],deps)).rejects.toThrow();expect(calls).toEqual([]);
    deps.load=()=>target;deps.run=async()=>({status:0,stderr:'',stdout:'[]'});await expect(runInitialCommand(['apply',...flags,'--confirm-initial-objects','initial-accounts-and-location'],deps)).rejects.toThrow();expect(writes).toEqual([]);
  }));
 });
 describe('production store read-only protocol and temporary SQL confidentiality',()=>{
  it('reads state using --command only, projects secrets privately and removes every write file',async()=>fixture(async({store})=>{
    const calls:string[][]=[],paths:string[]=[];
    const run:CliRunner=async args=>{calls.push(args);if(args.includes('--file')){const path=args[args.indexOf('--file')+1];paths.push(path);await store.write(await readFile(path,'utf8'));return {status:0,stdout:'upload progress',stderr:''};}const state=await store.readSnapshot();return {status:0,stderr:'',stdout:JSON.stringify([{success:true,results:[{state:JSON.stringify(state)}]}])};};
    const cli=createInitialCliStore(target,run,()=>target);expect(await cli.readSnapshot()).toEqual(await store.readSnapshot());expect(calls[0]).toContain('--command');expect(calls[0]).not.toContain('--file');
    await cli.write('SELECT 1;');for(const path of paths)await expect(readFile(path)).rejects.toThrow();
  }));
  it('rejects config drift before any CLI operation',async()=>fixture(async({store})=>{
    const calls:string[][]=[];const cli=createInitialCliStore(target,async args=>{calls.push(args);return {status:0,stdout:'[]',stderr:''};},()=>({...target,origin:'https://wrong.invalid'}));
    await expect(cli.readSnapshot()).rejects.toThrow('Konfigurasi berubah');expect(calls).toEqual([]);void store;
  }));
  it('verifies schema through a read-only migration store, with no initializer or importer',async()=>{
    let initialization=0,imports=0;const db=new DatabaseSync(':memory:');try{for(const sql of sqls)db.exec(sql);db.exec(MIGRATION_METADATA_SQL);for(const name of names)db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
    const fullStore: MigrationStore = {readState:async()=>({catalog:db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY type,name').all() as MigrationState['catalog'],migrations:db.prepare('SELECT id,name,applied_at FROM d1_migrations ORDER BY id').all() as MigrationState['migrations'],foreignKeys:1,foreignKeyViolations:[]}),initializeMetadata:async()=>{initialization++;},importFile:async()=>{imports++;}};
    await verifyAppliedMigrations(fullStore);
    expect([initialization,imports]).toEqual([0,0]);}finally{db.close();}
  });
 });
