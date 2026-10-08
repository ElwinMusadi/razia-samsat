import type { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../shared/errors';
import { createApp } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { vehicleCacheKey } from '../worker/vehicle/cache';
import type { VehicleSource } from '../worker/vehicle/contracts';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'https://app.test';
const RAID = '00000000-0000-4000-8000-000000000100';
const NEXT_RAID = '00000000-0000-4000-8000-000000000101';
const EVENT = new Date('2026-10-06T15:59:59.000Z');
const PLATES = ['DH1234ZZ','DH1','DH12','DH1234','DH1234Z','DH9876ZZ'];
let mf: Miniflare, db: TestD1, kv: KVNamespace, token: string, sessionId: string, now: Date;
let tasks: Promise<unknown>[], lines: string[], override: D1Database | undefined, expected: number;
let app: ReturnType<typeof createApp>, source: ReturnType<typeof vi.fn<VehicleSource['lookup']>>;
const sql = (query: string,...bindings: (string|number|null)[]) => db.prepare(query).bind(...bindings).run();
const rows = async (): Promise<Record<string,unknown>[]> => (await db.prepare('SELECT * FROM check_logs ORDER BY raid_session_id,nopol').all<Record<string,unknown>>()).results;
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
function found(nopol: unknown, tax: string|null = '2026-10-07') {
  if (typeof nopol !== 'string') throw new Error('Expected a normalized test plate');
  return {outcome:'FOUND' as const,vehicle:{nopol,owner_name:'Synthetic Owner',brand:'Brand',type:'Type',color:'Color',tax_due_date:tax,stnk_due_date:'2026-10-08',provider_fetched_at:now.toISOString(),source:'LIVE' as const}};
}
function configure() { app = createApp(createSafeLogger(line=>lines.push(line)),{source:{lookup:source},clock:()=>now,cache:kv}); }
function call(nopol='DH1234ZZ',cookie:string|null=token,signal?:AbortSignal) {
  return app.request(new Request(`${ORIGIN}/api/vehicle-lookups`,{method:'POST',body:JSON.stringify({nopol}),headers:{Origin:ORIGIN,'Content-Type':'application/json',...(cookie?{Cookie:`__Host-rs_session=${cookie}`}:{})},signal}),undefined,
    {DB:override??db,VEHICLE_CACHE:kv,PASSWORD_PBKDF2_ITERATIONS:'100000',SESSION_TTL_SECONDS:'43200'} as unknown as Env,
    {waitUntil(promise:Promise<unknown>){tasks.push(promise);},passThroughOnException(){},props:{}});
}
async function flush() { await Promise.all(tasks); }
async function success(nopol='DH1234ZZ') { const response = await call(nopol); expect(response.status).toBe(200); return response; }
async function clearCache(nopol='DH1234ZZ') { await kv.delete(await vehicleCacheKey(nopol)); }
// Gate only the exact production INSERT, not authorization reads; execute the actual bound SQL on release.
function interceptInsert(run: (statement:D1PreparedStatement,values:(string|number|null)[])=>Promise<unknown>, expiry?:()=>boolean) {
  const real = db as unknown as D1Database;
  override = {prepare(query:string){
    const actual = expiry?.() && query.includes('s.expires_at > unixepoch()') ? query.replace('s.expires_at > unixepoch()','s.expires_at > (unixepoch()+43201)') : query;
    const statement = real.prepare(actual);
    if (!query.includes('INSERT INTO check_logs')) return statement;
    expect(query).toContain('ON CONFLICT(raid_session_id, nopol) DO NOTHING');
    expect(query).not.toMatch(/INSERT OR IGNORE|is_active|revoked_at|expires_at|status = 'ACTIVE'/);
    return {bind(...values:(string|number|null)[]){const bound=statement.bind(...values);return {run:()=>run(bound,values)};}} as D1PreparedStatement;
  }} as D1Database;
}
beforeAll(async()=>{
  ({mf,db}=await startMigratedD1({modules:true,script:'export default {fetch(){return new Response("test")}}',kvNamespaces:['VEHICLE_CACHE']}));
  kv=await mf.getKVNamespace('VEHICLE_CACHE') as unknown as KVNamespace;
});
beforeEach(async()=>{
  await resetTestD1(db); for(const plate of PLATES) await clearCache(plate);
  now=new Date(EVENT); tasks=[]; lines=[]; override=undefined; expected=0;
  token=generateSessionToken(); sessionId=crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('user','synthetic.user','unused','OFFICER')"),
    db.prepare("INSERT INTO locations(id,name) VALUES('location','Synthetic location')"),
    db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200)').bind(sessionId,'user',await hashSessionToken(token)),
    db.prepare("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES(?,'user','location','A')").bind(RAID),
  ]);
  source=vi.fn(async nopol=>found(nopol)); configure();
});
afterEach(async()=>{await flush();expect(await db.prepare('SELECT count(*) AS n FROM check_logs').first('n')).toBe(expected);});
afterAll(async()=>{await mf?.dispose();});

describe('authorized minimal immutable history snapshots with actual D1/KV',()=>{
  it.each(['FOUND','NOT_FOUND'] as const)('%s writes exactly one minimal lookup-time snapshot',async outcome=>{
    expected=1; if(outcome==='NOT_FOUND')source.mockImplementation(async()=>({outcome:'NOT_FOUND'}));
    const response=await success(' dh 1234 zz '); const body=await response.json() as Record<string,unknown>; await flush();
    const [row]=await rows();
    expect(row).toEqual({id:expect.stringMatching(/^[0-9a-f-]{36}$/),raid_session_id:RAID,user_id:'user',idempotency_key:response.headers.get('x-request-id'),nopol:'DH1234ZZ',outcome,tax_status:outcome==='FOUND'?'ACTIVE':null,stnk_status:outcome==='FOUND'?'ACTIVE':null,source:'LIVE',checked_at:Math.floor(EVENT.getTime()/1000)});
    expect(Object.keys(row).sort()).toEqual(['checked_at','id','idempotency_key','nopol','outcome','raid_session_id','source','stnk_status','tax_status','user_id']);
    expect(JSON.stringify(row)).not.toMatch(/Synthetic Owner|owner_name|password|token|due_date|raw/);
    if(outcome==='FOUND')expect(body.vehicle).toMatchObject({tax_status:row.tax_status,stnk_status:row.stnk_status});
    else expect(body).toEqual({outcome:'NOT_FOUND',request_id:response.headers.get('x-request-id')});
  });
  it('LIVE then CACHE returns current recalculated status while first history source/status/time stay immutable',async()=>{
    expected=1;await success();await flush();const original=await rows();
    now=new Date('2026-10-06T16:00:00.000Z');
    const cached=await success();expect(await cached.json()).toMatchObject({source:'CACHE',vehicle:{tax_status:'EXPIRED'}});await flush();
    expect(source).toHaveBeenCalledTimes(1);expect(await rows()).toEqual(original);expect(lines).toEqual([]);
  });
  it('CACHE first is eligible and subsequent LIVE/status change does not overwrite',async()=>{
    expected=1;const vehicle=found('DH1234ZZ').vehicle;const {source:ignored,...cached}=vehicle;expect(ignored).toBe('LIVE');
    await kv.put(await vehicleCacheKey('DH1234ZZ'),JSON.stringify(cached),{expirationTtl:300});
    expect(await (await success()).json()).toMatchObject({source:'CACHE'});await flush();const original=await rows();
    await clearCache();now=new Date(now.getTime()+1000);source.mockImplementation(async nopol=>found(nopol,null));
    expect(await (await success()).json()).toMatchObject({source:'LIVE',vehicle:{tax_status:'UNKNOWN'}});await flush();
    expect(await rows()).toEqual(original);expect(original[0].source).toBe('CACHE');
  });
  it.each(['FOUND','NOT_FOUND'] as const)('first %s persists when later outcome changes',async first=>{
    expected=1;if(first==='NOT_FOUND')source.mockImplementation(async()=>({outcome:'NOT_FOUND'}));
    await success();await flush();const original=await rows();await clearCache();now=new Date(now.getTime()+1000);
    source.mockImplementation(async nopol=>first==='FOUND'?{outcome:'NOT_FOUND'}:found(nopol,null));
    expect(await (await success()).json()).toMatchObject({outcome:first==='FOUND'?'NOT_FOUND':'FOUND'});await flush();
    expect(await rows()).toEqual(original);expect(source).toHaveBeenCalledTimes(2);expect(lines).toEqual([]);
  });
  it('twenty concurrent normalized lowercase/whitespace equivalents persist one without overwrite or failure',async()=>{
    expected=1;const release=deferred<void>();const allStarted=deferred<void>();let calls=0;
    source.mockImplementation(async nopol=>{if(++calls===20)allStarted.resolve();await release.promise;return found(nopol);});
    const requests=Array.from({length:20},(_,n)=>call(n%2?' dh 1234 zz ':'DH1234ZZ'));
    await allStarted.promise;release.resolve();const responses=await Promise.all(requests);expect(responses.every(r=>r.status===200)).toBe(true);await flush();
    const [row]=await rows();expect(row.nopol).toBe('DH1234ZZ');expect(row.outcome).toBe('FOUND');
    expect(responses.map(r=>r.headers.get('x-request-id'))).toContain(row.idempotency_key);expect(source).toHaveBeenCalledTimes(20);expect(lines).toEqual([]);
  });
  it('valid prefixes/full NOPOL remain distinct and another raid creates a new record',async()=>{
    expected=5;for(const plate of ['DH1','DH12','DH1234','DH1234Z']){await success(plate);await flush();}
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=max(unixepoch(),started_at) WHERE id=?",RAID);
    await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES(?,'user','location','B')",NEXT_RAID);
    await success('DH1');await flush();
    expect((await rows()).map(r=>[r.raid_session_id,r.nopol])).toEqual([[RAID,'DH1'],[RAID,'DH12'],[RAID,'DH1234'],[RAID,'DH1234Z'],[NEXT_RAID,'DH1']]);
  });
  it('first successful INSERT wins, not the earliest captured timestamp',async()=>{
    expected=1;const entered=deferred<void>();const release=deferred<void>();let inserts=0;
    interceptInsert(async statement=>{if(++inserts===1){entered.resolve();await release.promise;}return statement.run();});
    const earlier=await success();await entered.promise;now=new Date(now.getTime()+1000);await clearCache();
    source.mockImplementation(async()=>({outcome:'NOT_FOUND'}));const later=await success();
    // The second job can finish while the earlier event is paused.
    await tasks.at(-1);const persisted=await rows();expect(persisted[0]).toMatchObject({outcome:'NOT_FOUND',checked_at:Math.floor(now.getTime()/1000),idempotency_key:later.headers.get('x-request-id')});
    expect(persisted[0].idempotency_key).not.toBe(earlier.headers.get('x-request-id'));
    release.resolve();await flush();expect(await rows()).toEqual(persisted);expect(lines).toEqual([]);
  });
  it('browser abort during provider work does not erase a valid completed server event',async()=>{
    expected=1;const entered=deferred<void>();const release=deferred<void>();const controller=new AbortController();
    source.mockImplementation(async nopol=>{entered.resolve();await release.promise;return found(nopol);});
    const request=call('DH1234ZZ',token,controller.signal);await entered.promise;controller.abort();release.resolve();
    expect((await request).status).toBe(200);await flush();expect((await rows())[0].raid_session_id).toBe(RAID);
  });
  it.each(['invalid','upstream','inactive','revoked','closed'] as const)('%s never creates an authorized history event',async state=>{
    if(state==='upstream')source.mockImplementation(async()=>{throw new AppError('UPSTREAM_NETWORK');});
    if(state==='inactive')await sql("UPDATE users SET is_active=0 WHERE id='user'");
    if(state==='revoked')await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?',sessionId);
    if(state==='closed')await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=max(unixepoch(),started_at) WHERE id=?",RAID);
    const response=await call(state==='invalid'?'DH-1234ZZ':'DH1234ZZ');
    expect(response.status).toBe(state==='invalid'?400:state==='upstream'?502:state==='closed'?409:401);await flush();expect(await rows()).toEqual([]);
  });
});

describe('D5-02 exact INSERT gate and background failure isolation',()=>{
  it.each(['inactive','expiry','logout','revoke','close','close-new-raid'] as const)('allowed old snapshot survives %s before INSERT',async state=>{
    expected=1;const entered=deferred<void>();const release=deferred<void>();let expired=false;let captured:(string|number|null)[]=[];
    interceptInsert(async(statement,values)=>{captured=values;entered.resolve();await release.promise;return statement.run();},()=>expired);
    const response=await success();await entered.promise;
    // Final auth already passed. Move the evaluation clock while the background write is paused.
    now=new Date('2026-10-07T16:00:00.000Z');
    if(state==='inactive')await sql("UPDATE users SET is_active=0 WHERE id='user'");
    if(state==='expiry')expired=true;
    if(state==='revoke')await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?',sessionId);
    if(state==='logout') {
      const logout=await app.request(`${ORIGIN}/api/auth/logout`,{method:'POST',body:'{}',headers:{Origin:ORIGIN,'Content-Type':'application/json',Cookie:`__Host-rs_session=${token}`}},
        {DB:override,PASSWORD_PBKDF2_ITERATIONS:'100000',SESSION_TTL_SECONDS:'43200'} as unknown as Env);
      expect(logout.status).toBe(204);
    }
    if(state==='close'||state==='close-new-raid')await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=max(unixepoch(),started_at) WHERE id=?",RAID);
    if(state==='close-new-raid')await sql("INSERT INTO raid_sessions(id,user_id,location_id,lane) VALUES(?,'user','location','B')",NEXT_RAID);
    release.resolve();await flush();
    expect(captured).toHaveLength(10);expect(captured.slice(1)).toEqual([RAID,'user',response.headers.get('x-request-id'),'DH1234ZZ','FOUND','ACTIVE','ACTIVE','LIVE',Math.floor(EVENT.getTime()/1000)]);
    expect((await rows())[0]).toMatchObject({raid_session_id:RAID,checked_at:Math.floor(EVENT.getTime()/1000),tax_status:'ACTIVE'});
    expect(lines.filter(l=>l.includes('history_write_failed'))).toEqual([]);
    if(['inactive','expiry','logout','revoke'].includes(state))expect((await call()).status).toBe(401);
    if(state==='close')expect((await call()).status).toBe(409);
  });
  it('paused INSERT is not awaited by response; late SQL rejection is safe and observable without retry',async()=>{
    const entered=deferred<void>();const release=deferred<void>();let attempts=0;
    interceptInsert(async()=>{attempts++;entered.resolve();await release.promise;throw new Error('FORBIDDEN_SENTINEL DH1234ZZ Synthetic Owner raw SQL');});
    const response=await success();await entered.promise;expect(await rows()).toEqual([]);
    expect(await response.json()).toMatchObject({outcome:'FOUND'});expect(lines).toEqual([]);
    release.resolve();await flush();expect(attempts).toBe(1);
    expect(lines.map(l=>JSON.parse(l))).toEqual([{event:'history_write_failed',request_id:response.headers.get('x-request-id')}]);
    expect(lines.join('')).not.toMatch(/FORBIDDEN_SENTINEL|DH1234ZZ|Synthetic Owner|SQL/);
  });
  it('actual FK failure is observed but cannot turn successful lookup into an error',async()=>{
    const entered=deferred<void>();const release=deferred<void>();interceptInsert(async statement=>{entered.resolve();await release.promise;return statement.run();});
    const response=await success();await entered.promise;await sql('DELETE FROM raid_sessions WHERE id=?',RAID);
    release.resolve();await flush();expect(response.status).toBe(200);expect(lines.map(l=>JSON.parse(l).event)).toEqual(['history_write_failed']);
  });
  it('unexpected technical UUID-key conflict is not blanket-ignored',async()=>{
    expected=1;await success();await flush();const [original]=await rows();await clearCache('DH9876ZZ');
    const real=db as unknown as D1Database;
    override={prepare(query:string){const statement=real.prepare(query);if(!query.includes('INSERT INTO check_logs'))return statement;
      return {bind(...values:(string|number|null)[]){values[3]=original.idempotency_key as string;return statement.bind(...values);}} as D1PreparedStatement;
    }} as D1Database;
    const response=await success('DH9876ZZ');await flush();expect(await rows()).toEqual([original]);
    expect(lines.map(l=>JSON.parse(l))).toEqual([{event:'history_write_failed',request_id:response.headers.get('x-request-id')}]);
  });
  it('safe logger projects only allowlisted event/request ID and never raw payload',()=>{
    const safe=createSafeLogger(line=>lines.push(line));
    safe({event:'history_write_failed',request_id:crypto.randomUUID(),...{nopol:'DH1234ZZ',raw:'FORBIDDEN_SENTINEL',owner_name:'Synthetic Owner'}});
    expect(lines).toHaveLength(1);expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['event','request_id']);
    expect(lines[0]).not.toMatch(/DH1234ZZ|FORBIDDEN_SENTINEL|Synthetic Owner/);
  });
});
