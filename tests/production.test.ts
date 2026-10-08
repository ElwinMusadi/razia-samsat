import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { hashPassword, verifyPassword } from '../shared/password';
import { PROJECT_ROOT } from '../scripts/lib';
import { confirmTarget, EXPECTED_ACCOUNT, EXPECTED_DATABASE, EXPECTED_NAMESPACE, EXPECTED_WORKER, PRODUCTION_CONFIG, validateProductionConfig, verifyInventory } from '../scripts/production-config';
import { bootstrapAdmin, buildBootstrapSql, EMPTY_USERS_SQL, executeRemoteSql, runProduction, verifyDomain, verifyWorker, type CliResult, type OperationDependencies, type SqlRunner } from '../scripts/production';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

// Synthetic identifiers and hostnames are test-only, never operator inventory.
const DB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const AUDIT_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '55555555-5555-4555-8555-555555555555';
const DNS_ID = 'c'.repeat(32);
const deployment = (id = DEPLOYMENT_ID, version = VERSION_ID, created = '2026-10-08T01:00:00Z') => ({ id,created_on:created,versions:[{version_id:version,percentage:100}] });
const domainFlags = () => new Map([['confirm-hostname-review',`https://${HOST}`]]);
const KV_ID = 'a'.repeat(32), ZONE_ID = 'b'.repeat(32);
const HOST = 'synthetic.razia-domain.net';
const config = () => ({ $schema: 'node_modules/wrangler/config-schema.json', name: EXPECTED_WORKER, account_id: EXPECTED_ACCOUNT, main: 'worker/index.ts', compatibility_date: '2026-10-07', workers_dev: false, preview_urls: false,
  routes: [{ pattern: HOST, zone_id: ZONE_ID, custom_domain: true }],
  assets: { directory: './dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api','/api/*'] },
  d1_databases: [{ binding: 'DB', database_name: EXPECTED_DATABASE, database_id: DB_ID, migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'VEHICLE_CACHE', id: KV_ID }],
  vars: { PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' },
  observability: { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } } });
const target = validateProductionConfig(config());
const flags = () => new Map([['confirm-account',target.account],['confirm-worker',target.worker],['confirm-database',target.database],['confirm-origin',target.origin]]);
const argvFlags = () => [...flags()].flatMap(([key,value]) => [`--${key}`,value]);
const inventory = () => ({ whoami: { loggedIn: true, accounts: [{id:EXPECTED_ACCOUNT,name:'Synthetic'}] }, databases: [{ uuid: DB_ID,name:EXPECTED_DATABASE }], namespaces: [{id:KV_ID,title:EXPECTED_NAMESPACE}] });
const result = (value: unknown): CliResult => ({ status:0,stdout:JSON.stringify(value),stderr:'' });

describe('production strict local configuration', () => {
  it('accepts exact baseline with root-relative existing entrypoint/assets/migrations', () => {
    expect(target).toEqual({account:EXPECTED_ACCOUNT,worker:EXPECTED_WORKER,database:DB_ID,namespace:KV_ID,hostname:HOST,origin:`https://${HOST}`,zone:ZONE_ID});
    expect(() => validateProductionConfig(config(),join(PROJECT_ROOT,'other/wrangler.production.jsonc'))).toThrow();
  });
  it('reads checked JSONC using installed Wrangler and rejects intentionally invalid placeholders', () => {
    const {rawConfig} = experimental_readRawConfig({config:join(PROJECT_ROOT,'wrangler.production.example.jsonc')});
    expect(() => validateProductionConfig(rawConfig)).toThrow();
  });
  it.each([
    ['account_id','0'.repeat(32)], ['account_id','c'.repeat(32)], ['name','another-worker'], ['main','../worker/index.ts'], ['workers_dev',true], ['preview_urls',true], ['compatibility_date','2026-10-08'], ['env',{}], ['services',[]], ['build',{command:'evil'}], ['unsafe',{}], ['secrets',{}], ['limits',{cpu_ms:100}], ['triggers',{crons:['* * * * *']}], ['route','somewhere/*'],
  ])('rejects changed/unknown top-level %s', (key,value) => { expect(() => validateProductionConfig({...config(),[key]:value})).toThrow(); });
  it.each(['d1_databases','kv_namespaces','routes'])('rejects duplicate/missing %s', key => {
    const value = config()[key as 'routes'];
    expect(() => validateProductionConfig({...config(),[key]:[]})).toThrow();
    expect(() => validateProductionConfig({...config(),[key]:[...value,...value]})).toThrow();
  });
  it.each(['00000000-0000-0000-0000-000000000000','not-uuid','11111111111141118111111111111111'])('rejects invalid D1 ID %s', id => { const value=config(); value.d1_databases[0].database_id=id; expect(() => validateProductionConfig(value)).toThrow(); });
  it.each(['0'.repeat(32),'x'.repeat(32),'a'.repeat(31)])('rejects invalid namespace ID %s', id => { const value=config(); value.kv_namespaces[0].id=id; expect(() => validateProductionConfig(value)).toThrow(); });
  it('rejects local and unknown binding metadata', () => {
    for (const key of ['d1_databases','kv_namespaces'] as const) {
      const value=config(); Object.assign(value[key][0],{remote:false}); expect(() => validateProductionConfig(value)).toThrow();
      const unknown=config(); Object.assign(unknown[key][0],{preview_id:KV_ID}); expect(() => validateProductionConfig(unknown)).toThrow();
    }
    const wrong=config(); wrong.d1_databases[0].database_name='unrelated'; expect(() => validateProductionConfig(wrong)).toThrow();
  });
  it.each(['PASSWORD_PBKDF2_ITERATIONS','SESSION_TTL_SECONDS','RETENTION_POLICY'])('requires exact %s not minimum', key => {
    for (const value of ['100001','99999','43201','43200 ',100000,'30d']) expect(() => validateProductionConfig({...config(),vars:{...config().vars,[key]:value}})).toThrow();
  });
  it.each(['app.invalid','app.test','app.example','example.com','app.workers.dev','https://app.net','app.net/*','app.net:443','localhost','APP.NET'])('rejects placeholder/unsafe route %s', pattern => { const value=config(); value.routes[0].pattern=pattern; expect(() => validateProductionConfig(value)).toThrow(); });
  it('rejects unsafe telemetry and asset routing', () => {
    const traces=config(); traces.observability.traces.enabled=true; expect(() => validateProductionConfig(traces)).toThrow();
    const invocation=config(); invocation.observability.logs.invocation_logs=true; expect(() => validateProductionConfig(invocation)).toThrow();
    const asset=config(); asset.assets.run_worker_first=['/*']; expect(() => validateProductionConfig(asset)).toThrow();
    const binding=config(); binding.assets.binding='OTHER'; expect(() => validateProductionConfig(binding)).toThrow();
  });
  it('requires all exact confirmations', () => {
    for (const key of flags().keys()) { const value=flags(); value.delete(key); expect(() => confirmTarget(target,value)).toThrow(); const wrong=flags(); wrong.set(key,'other'); expect(() => confirmTarget(target,wrong)).toThrow(); }
  });
  it('verifies unique paired account/name/ID and refuses unrelated, absent or duplicate inventory', () => {
    const good=inventory(); expect(() => verifyInventory(target,good.whoami,good.databases,good.namespaces)).not.toThrow();
    for (const dbs of [[],[{uuid:DB_ID,name:'unrelated'}],[{uuid:VERSION_ID,name:EXPECTED_DATABASE}],[...good.databases,...good.databases]]) expect(() => verifyInventory(target,good.whoami,dbs,good.namespaces)).toThrow();
    for (const namespaces of [[],[{id:KV_ID,title:'unrelated'}],[...good.namespaces,...good.namespaces]]) expect(() => verifyInventory(target,good.whoami,good.databases,namespaces)).toThrow();
    expect(() => verifyInventory(target,{loggedIn:false,accounts:good.whoami.accounts},good.databases,good.namespaces)).toThrow();
  });
  it('ignored operator config and backups do not replace local scripts', async () => {
    const ignored=await readFile(join(PROJECT_ROOT,'.gitignore'),'utf8'); expect(ignored).toContain('wrangler.production.jsonc'); expect(ignored).toContain('backups/');
    const pkg=JSON.parse(await readFile(join(PROJECT_ROOT,'package.json'),'utf8')); expect(pkg.scripts['db:migrate:local']).toContain('--local'); expect(pkg.scripts['bootstrap:user']).toBe('node scripts/create-user.ts');
  });
  it('CLI invalid arguments fail without config/network or sensitive argument echo', () => {
    const execution=spawnSync(process.execPath,[join(PROJECT_ROOT,'scripts/production.ts'),'deploy','--password','Sensitive-Synthetic'],{cwd:PROJECT_ROOT,encoding:'utf8'});
    expect(execution.status).toBe(1); expect(execution.stdout).toBe(''); expect(execution.stderr).not.toContain('Sensitive-Synthetic'); expect(execution.stderr).not.toContain('cloudflare.com');
  });
});

describe('operator command boundaries with injected CLI, not remote success claims', () => {
  function dependencies() {
    const calls: string[][]=[]; const inv=inventory();
    const deps:OperationDependencies={ load:()=>target, run:async args=>{calls.push(args); if(args[0]==='whoami') return result(inv.whoami); if(args[0]==='d1' && args[1]==='list') return result(inv.databases); if(args[0]==='kv') return result(inv.namespaces); if(args[0]==='deployments') return result([deployment()]); return result([]);},password:async()=>{throw new Error('not expected');},domain:async()=>{},sql:async()=>{throw new Error('not expected');},notice:()=>{} };
    return {deps,calls};
  }
  it('check and dryrun never inventory or remote write', async () => {
    const {deps,calls}=dependencies(); await runProduction(['check'],deps); expect(calls).toEqual([]); await runProduction(['dryrun'],deps); expect(calls).toEqual([['deploy','--dry-run','--autoconfig=false']]);
  });
  it('invalid config and missing confirmations refuse before any CLI', async () => {
    const {deps,calls}=dependencies(); deps.load=()=>validateProductionConfig({...config(),name:'wrong'}); await expect(runProduction(['deploy',...argvFlags()],deps)).rejects.toThrow(); expect(calls).toEqual([]);
    const normal=dependencies(); await expect(runProduction(['migrate'],normal.deps)).rejects.toThrow(); expect(normal.calls).toEqual([]);
  });
  it('inventory mismatch fails before any network write', async () => {
    const {deps,calls}=dependencies(); const run=deps.run; deps.run=async args=>args[0]==='kv' ? result([]) : run(args);
    await expect(runProduction(['migrate',...argvFlags()],deps)).rejects.toThrow(); expect(calls.every(args=>!args.includes('--remote'))).toBe(true);
  });
  it('migrate uses remote explicit DB after exactly read-only inventory', async () => {
    const {deps,calls}=dependencies(); await runProduction(['migrate',...argvFlags()],deps); expect(calls).toEqual([['whoami','--json'],['d1','list','--json'],['kv','namespace','list'],['d1','migrations','apply','DB','--remote']]);
  });
  it('existing Worker confirms active deployment/version, not latest upload or array order', async () => {
    const {deps,calls}=dependencies(); const run=deps.run;
    deps.run=async args=>args[0]==='deployments' ? result([deployment(),deployment(USER_ID,USER_ID,'2026-10-07T01:00:00Z')]) : run(args);
    let domain=false; deps.domain=async()=>{domain=true;};
    await expect(runProduction(['deploy',...argvFlags()],deps)).rejects.toThrow(); expect(domain).toBe(false);
    await expect(runProduction(['deploy',...argvFlags(),'--confirm-deployment',DEPLOYMENT_ID,'--confirm-version',USER_ID],deps)).rejects.toThrow();
    await expect(runProduction(['deploy',...argvFlags(),'--confirm-deployment',USER_ID,'--confirm-version',VERSION_ID],deps)).rejects.toThrow();
    await runProduction(['deploy',...argvFlags(),'--confirm-deployment',DEPLOYMENT_ID,'--confirm-version',VERSION_ID],deps);
    expect(domain).toBe(true); expect(calls.some(args=>args[0]==='versions')).toBe(false); expect(calls.at(-1)).toEqual(['deploy','--strict','--autoconfig=false']);
  });
  it.each([
    {value:[]}, {value:{}}, {value:[{id:VERSION_ID}]}, {value:[deployment(),deployment(USER_ID,USER_ID)]}, {value:[{...deployment(),created_on:'invalid'}]}, {value:[{...deployment(),created_on:'2026-02-30T01:00:00Z'}]},
    {value:[{...deployment(),versions:[{version_id:VERSION_ID,percentage:50},{version_id:USER_ID,percentage:50}]}]}, {value:[{...deployment(),versions:[{version_id:VERSION_ID,percentage:99}]}]},
  ])('rejects empty, ambiguous, malformed or gradual deployments %#', async ({value}) => {
    const confirmations=flags(); confirmations.set('confirm-version',VERSION_ID); confirmations.set('confirm-deployment',DEPLOYMENT_ID);
    await expect(verifyWorker(target,confirmations,async()=>result(value))).rejects.toThrow();
  });
  it('only exact authoritative not-found plus explicit new-target confirmation accepts new Worker', async () => {
    const confirmations=flags(); confirmations.set('confirm-new-worker',target.worker);
    for (const stderr of ['[code: 10000]','network failed','forbidden','']) await expect(verifyWorker(target,confirmations,async()=>({status:1,stdout:'',stderr}))).rejects.toThrow();
    await expect(verifyWorker(target,flags(),async()=>({status:1,stdout:'',stderr:'[code: 10007]'}))).rejects.toThrow();
    await expect(verifyWorker(target,confirmations,async()=>({status:1,stdout:'',stderr:'[code: 10007]'}))).resolves.toBeUndefined();
  });
  it('temporary SQL file is private, passed by file only and deleted even CLI failure', async () => {
    let path=''; const sql='SELECT 1; -- synthetic SQL sentinel';
    await expect(executeRemoteSql(sql,async args=>{path=args[args.indexOf('--file')+1]; expect(args).toEqual(['d1','execute','DB','--remote','--file',path,'--json','--yes']); expect(args.join(' ')).not.toContain(sql); expect(await readFile(path,'utf8')).toBe(sql); return {status:1,stdout:sql,stderr:sql};})).rejects.toThrow('output mentah');
    await expect(readFile(path)).rejects.toThrow();
  });
  function domainRequest(options: { dns?: Record<string,unknown>[]; domains?: Record<string,unknown>[]; info?: Record<string,unknown> | null; routes?: Record<string,unknown>[] } = {}): typeof fetch {
    const dns=options.dns??[];
    return async input=>{
      const url=new URL(String(input));
      let payload:Record<string,unknown>;
      if(url.pathname.endsWith('/dns_records')) {
        expect(url.searchParams.get('name.exact')).toBe(HOST); expect(url.searchParams.get('per_page')).toBe('100'); expect(url.searchParams.get('page')).toBe('1');
        payload={success:true,result:dns,...(options.info===null ? {} : {result_info:options.info??{page:1,per_page:100,count:dns.length,total_count:dns.length,total_pages:1}})};
      } else if(url.pathname.endsWith('/workers/routes')) payload={success:true,result:options.routes??[]};
      else if(url.pathname.endsWith('/workers/domains')) payload={success:true,result:options.domains??[]};
      else payload={success:true,result:{id:ZONE_ID,status:'active',name:'razia-domain.net',account:{id:EXPECTED_ACCOUNT}}};
      return new Response(JSON.stringify(payload),{status:200});
    };
  }
  it('domain verification checks zone, DNS pagination and unrelated service without writes', async () => {
    await expect(verifyDomain(target,undefined,async()=>{throw new Error('must not fetch');})).rejects.toThrow();
    await expect(verifyDomain(target,'Synthetic-token',domainRequest(),domainFlags())).resolves.toBeUndefined();
    await expect(verifyDomain(target,'Synthetic-token',domainRequest({domains:[{hostname:HOST,service:'unrelated',zone_id:ZONE_ID}]}),domainFlags())).rejects.toThrow();
  });
  it.each(['A','AAAA','CNAME','MX'])('new/unbound hostname refuses existing DNS %s even with arbitrary confirmation before deploy', async type => {
    const {deps,calls}=dependencies();
    deps.domain=async(target,confirmations)=>verifyDomain(target,'Synthetic-token',domainRequest({dns:[{id:DNS_ID,name:HOST,type,proxied:true}]}),confirmations);
    await expect(runProduction(['deploy',...argvFlags(),'--confirm-deployment',DEPLOYMENT_ID,'--confirm-version',VERSION_ID,'--confirm-hostname-review',target.origin,'--confirm-dns-record',DNS_ID],deps)).rejects.toThrow('DNS hostname sudah ada');
    expect(calls.some(args=>args[0]==='deploy')).toBe(false);
  });
  it('existing exact Worker binding accepts one reviewed DNS record and active deployment confirmation', async () => {
    const {deps,calls}=dependencies();
    deps.domain=async(target,confirmations)=>verifyDomain(target,'Synthetic-token',domainRequest({domains:[{hostname:HOST,service:EXPECTED_WORKER,zone_id:ZONE_ID}],dns:[{id:DNS_ID,name:HOST,type:'AAAA',proxied:true}]}),confirmations);
    const args=['deploy',...argvFlags(),'--confirm-deployment',DEPLOYMENT_ID,'--confirm-version',VERSION_ID,'--confirm-hostname-review',target.origin];
    await expect(runProduction(args,deps)).rejects.toThrow('DNS hostname sudah ada');
    await runProduction([...args,'--confirm-dns-record',DNS_ID],deps); expect(calls.at(-1)).toEqual(['deploy','--strict','--autoconfig=false']);
  });
  it.each([
    null, {}, {page:1,per_page:100,count:0,total_count:0,total_pages:'1'}, {page:1,per_page:0,count:0,total_count:0,total_pages:1}, {page:1,per_page:100,count:0,total_count:101,total_pages:2}, {page:2,per_page:100,count:0,total_count:0,total_pages:1}, {page:1,per_page:100,count:1,total_count:0,total_pages:1},
  ])('rejects missing or truncated DNS metadata %#', async info => {
    await expect(verifyDomain(target,'Synthetic-token',domainRequest({info}),domainFlags())).rejects.toThrow();
  });
  it('rejects duplicate DNS, wrong name/type, wrong zone and missing review', async () => {
    const dns={id:DNS_ID,name:HOST,type:'AAAA',proxied:true}; const domains=[{hostname:HOST,service:EXPECTED_WORKER,zone_id:ZONE_ID}]; const confirmations=domainFlags(); confirmations.set('confirm-dns-record',DNS_ID);
    for(const records of [[dns,dns],[{...dns,type:'CNAME'}],[{...dns,name:'another.razia-domain.net'}],[{...dns,proxied:false}]]) await expect(verifyDomain(target,'Synthetic-token',domainRequest({dns:records,domains}),confirmations)).rejects.toThrow();
    await expect(verifyDomain(target,'Synthetic-token',domainRequest({domains:[{...domains[0],zone_id:KV_ID}]}),domainFlags())).rejects.toThrow();
    await expect(verifyDomain(target,'Synthetic-token',domainRequest(),new Map())).rejects.toThrow();
  });
  it.each([`https://${HOST}/*`,'*.razia-domain.net/*','*/*'])('rejects active route covering hostname %s', async pattern => {
    await expect(verifyDomain(target,'Synthetic-token',domainRequest({routes:[{pattern,script:'unrelated-worker'}]}),domainFlags())).rejects.toThrow('Route Worker aktif');
  });
});

let mf:Miniflare, db:TestD1, passwordHash:string;
beforeAll(async()=>{ ({mf,db}=await startMigratedD1()); passwordHash=await hashPassword('Synthetic-bootstrap',100000); });
afterAll(async()=>{await mf?.dispose();});
beforeEach(async()=>{if(db) await resetTestD1(db);});
const execute:SqlRunner=async sql=>[await db.prepare(sql).all()];
describe('first ADMIN actual local D1 with all three migrations', () => {
  it('normalizes canonical username, validates hash and escapes SQL values', () => {
    const sql=buildBootstrapSql(USER_ID,AUDIT_ID,' Synthetic.Admin ',passwordHash); expect(sql.insert).toContain("'synthetic.admin'"); expect(sql.insert).toContain('WHERE NOT EXISTS (SELECT 1 FROM users)'); expect(sql.create).toContain(`WHEN NEW.id = '${USER_ID}'`);
    expect(()=>buildBootstrapSql(USER_ID,AUDIT_ID,"injection');--",passwordHash)).toThrow(); expect(()=>buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic',passwordHash.replace('$100000$','$1000$'))).toThrow();
  });
  it('empty DB creates exactly first active ADMIN and USER_CREATED audit atomically', async()=>{
    const sql=buildBootstrapSql(USER_ID,AUDIT_ID,' Synthetic.Admin ',passwordHash); await bootstrapAdmin(sql,execute,()=>{});
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1); expect(await db.prepare('SELECT username,role,is_active FROM users').first()).toEqual({username:'synthetic.admin',role:'ADMIN',is_active:1});
    expect(await db.prepare('SELECT actor_user_id,action,target_user_id FROM admin_audit_logs').first()).toEqual({actor_user_id:USER_ID,action:'USER_CREATED',target_user_id:USER_ID});
    expect((await verifyPassword('Synthetic-bootstrap',String(await db.prepare('SELECT password_hash FROM users').first('password_hash')))).ok).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?').bind(sql.triggerName).first('n')).toBe(0); expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(bootstrapAdmin(buildBootstrapSql(VERSION_ID,crypto.randomUUID(),'second',passwordHash),execute,()=>{})).rejects.toThrow('harus kosong'); expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1);
  });
  it.each([0,1])('nonempty OFFICER table blocks bootstrap even is_active=%s', async active=>{
    await db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES('officer','synthetic.officer','unused','OFFICER',?)").bind(active).run();
    await expect(bootstrapAdmin(buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic.admin',passwordHash),execute,()=>{})).rejects.toThrow('harus kosong'); expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(0);
  });
  it('two concurrent attempts insert only one ADMIN and one audit', async()=>{
    const attempts=[buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic.first',passwordHash),buildBootstrapSql(VERSION_ID,crypto.randomUUID(),'synthetic.second',passwordHash)];
    const outcomes=await Promise.allSettled(attempts.map(sql=>bootstrapAdmin(sql,execute,()=>{}))); expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1); expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(1);
  });
  it('audit failure rolls back the user INSERT and removes dedicated trigger', async()=>{
    await db.prepare("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;").run();
    const sql=buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic.admin',passwordHash);
    try { await expect(bootstrapAdmin(sql,execute,()=>{})).rejects.toThrow('synthetic audit failure'); expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0); expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(0); expect(await db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?').bind(sql.triggerName).first('n')).toBe(0); }
    finally {await db.prepare('DROP TRIGGER synthetic_audit_failure').run();}
  });
  it('cleanup failure preserves committed user/audit and emits only safe nonce notice', async()=>{
    const sql=buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic.admin',passwordHash), notices:string[]=[];
    try { await expect(bootstrapAdmin(sql,async query=>{if(query===sql.drop) throw new Error(`unsafe ${passwordHash}`); return execute(query);},message=>notices.push(message))).rejects.toThrow('pembersihan'); expect(notices).toHaveLength(1); expect(notices[0]).toContain(sql.triggerName); expect(notices[0]).not.toContain(passwordHash); expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1); }
    finally {await execute(sql.drop);}
  });
  it('restricted trigger does not audit any other UUID even first active ADMIN', async()=>{
    const sql=buildBootstrapSql(USER_ID,AUDIT_ID,'synthetic.admin',passwordHash); await execute(sql.create);
    try {await db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.other',?,'ADMIN')").bind(VERSION_ID,passwordHash).run(); expect(await db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs').first('n')).toBe(0);}
    finally {await execute(sql.drop);}
  });
  it('empty preflight SQL selects count only without credentials',()=>{expect(EMPTY_USERS_SQL).toBe('SELECT COUNT(*) AS users_count FROM users;'); expect(PRODUCTION_CONFIG).toBe(join(PROJECT_ROOT,'wrangler.production.jsonc'));});
});
