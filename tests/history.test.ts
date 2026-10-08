import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../worker/index';
import { encodeHistoryCursor, type HistoryCheck, type HistoryRaid } from '../worker/history';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

const ORIGIN = 'https://app.test';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = uuid(1), OTHER = uuid(2), ADMIN = uuid(3), LOCATION = uuid(4), RAID = uuid(100), OTHER_RAID = uuid(101);
const TIME = 1700000000;
const LIST = '/api/history/raid-sessions';
const paths = [LIST, `/api/raid-sessions/${RAID}/checks`, `/api/raid-sessions/${RAID}/summary`];
let mf: Miniflare, db: TestD1, token: string, adminToken: string, sessionId: string;
let override: D1Database | undefined;
const app = createApp(() => {});
const sql = (query: string, ...bindings: (string | number | null)[]) => db.prepare(query).bind(...bindings).run();
function get(path: string, cookie: string | null = token) {
  return app.request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: `__Host-rs_session=${cookie}` } : {} },
    { DB: override ?? db, PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200' } as unknown as Env);
}
async function reject(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: { code, message: expect.any(String), request_id: response.headers.get('x-request-id') } });
}
async function raid(id: string, user = USER, started = TIME, active = false) {
  await sql(`INSERT INTO raid_sessions(id,user_id,location_id,lane,status,started_at,closed_at) VALUES(?,?,?,'A',?,?,?)`,
    id, user, LOCATION, active ? 'ACTIVE' : 'CLOSED', started, active ? null : started + 1);
}
async function check(n: number, raidId = RAID, user = USER, tax: string | null = 'ACTIVE', checked = TIME) {
  await sql(`INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,tax_status,stnk_status,source,checked_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, uuid(1000 + n), raidId, user, uuid(2000 + n), `DH${n}ZZ`, tax === null ? 'NOT_FOUND' : 'FOUND', tax, tax === null ? null : 'UNKNOWN', tax === null ? 'LIVE' : 'CACHE', checked);
}
async function list(path = LIST, cookie = token) {
  const response = await get(path, cookie); expect(response.status).toBe(200);
  return await response.json() as { raid_sessions: HistoryRaid[]; next_cursor: string | null };
}
async function checks(path = `/api/raid-sessions/${RAID}/checks`) {
  const response = await get(path); expect(response.status).toBe(200);
  return await response.json() as { checks: HistoryCheck[]; next_cursor: string | null };
}
// Intercept immediately before the production read batch; all results still come from actual D1.
function intercept(beforeBatch: () => Promise<void>, expired = false, plans?: { query: string; bindings: (string | number | null)[] }[]) {
  const real = db as unknown as D1Database;
  const metadata = new WeakMap<D1PreparedStatement, { query: string; bindings: (string | number | null)[] }>();
  override = { prepare(query: string) {
    const actual = expired && query.includes('CASE WHEN u.role') ? query.replace('s.expires_at > unixepoch()', 's.expires_at > (unixepoch()+43201)') : query;
    return { bind(...bindings: (string | number | null)[]) {
      const statement = real.prepare(actual).bind(...bindings);
      metadata.set(statement, { query: actual, bindings });
      return statement;
    } } as D1PreparedStatement;
  }, async batch(statements: D1PreparedStatement[]) {
    await beforeBatch();
    if (plans) for (const statement of statements) plans.push(metadata.get(statement)!);
    return real.batch(statements);
  } } as D1Database;
}
beforeAll(async () => { ({ mf, db } = await startMigratedD1()); });
beforeEach(async () => {
  await resetTestD1(db); override = undefined;
  token = generateSessionToken(); adminToken = generateSessionToken(); sessionId = uuid(10);
  await db.batch([
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES(?,'synthetic.officer','unused','OFFICER'),(?,'synthetic.other','unused','OFFICER'),(?,'synthetic.admin','unused','ADMIN')").bind(USER, OTHER, ADMIN),
    db.prepare("INSERT INTO locations(id,name) VALUES(?,'Synthetic location')").bind(LOCATION),
    db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200),(?,?,?,unixepoch()+43200)').bind(sessionId, USER, await hashSessionToken(token), uuid(11), ADMIN, await hashSessionToken(adminToken)),
  ]);
  await raid(RAID, USER, TIME, true); await raid(OTHER_RAID, OTHER);
});
afterAll(async () => { await mf?.dispose(); });

describe('history authorization and exact public contracts with actual workerd D1', () => {
  it('OFFICER reads own active and closed raids without requiring an active operation', async () => {
    const closed = uuid(102); await raid(closed);
    expect((await list()).raid_sessions.map(r => r.id)).toEqual([closed, RAID]);
    await sql("UPDATE raid_sessions SET status='CLOSED',closed_at=started_at+1 WHERE id=?", RAID);
    for (const id of [RAID, closed]) {
      expect(await checks(`/api/raid-sessions/${id}/checks`)).toEqual({ checks: [], next_cursor: null });
      const response = await get(`/api/raid-sessions/${id}/summary`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ raid_session: { id, location: { id: LOCATION, name: 'Synthetic location' }, lane: 'A', status: 'CLOSED', started_at: TIME, closed_at: TIME+1, owner: { id: USER, username: 'synthetic.officer' } }, summary: { total_checks: 0, found: 0, not_found: 0, tax_active: 0, tax_expired: 0, tax_unknown: 0 } });
    }
  });
  it('ADMIN lists all owners and reads another officer checks and summary', async () => {
    await check(1, OTHER_RAID, OTHER);
    expect((await list(LIST, adminToken)).raid_sessions.map(r => r.owner.id)).toEqual([OTHER, USER]);
    for (const suffix of ['checks', 'summary']) expect((await get(`/api/raid-sessions/${OTHER_RAID}/${suffix}`, adminToken)).status).toBe(200);
  });
  it.each(['checks', 'summary'])('other owner, missing, non-UUID and uppercase targets uniformly return 404 for %s', async suffix => {
    for (const id of [OTHER_RAID, uuid(999), 'not-a-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) {
      const response = await get(`/api/raid-sessions/${id}/${suffix}`);
      await reject(response, 404, 'RAID_SESSION_NOT_FOUND'); expect(response.headers.get('set-cookie')).toBeNull();
    }
  });
  it.each(paths)('rejects invalid initial auth at %s', async path => {
    for (const cookie of [null, 'malformed']) await reject(await get(path, cookie), 401, 'AUTHENTICATION_ERROR');
  });
  it.each(['revoked', 'inactive', 'expired'] as const)('initial %s auth is rejected, with cookie cleared', async state => {
    if (state === 'revoked') await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
    if (state === 'inactive') await sql('UPDATE users SET is_active=0 WHERE id=?', USER);
    if (state === 'expired') {
      await sql('DELETE FROM user_sessions WHERE id=?', sessionId);
      await sql('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,1,2)', sessionId, USER, await hashSessionToken(token));
    }
    for (const path of paths) {
      const response = await get(path); await reject(response, 401, 'AUTHENTICATION_ERROR');
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });
  it.each(paths)('rechecks revoke after middleware before exposing %s', async path => {
    await check(1);
    intercept(async () => {
      await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
      // A different valid session of the same account cannot authorize this cookie request.
      await sql('INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,unixepoch()+43200)', uuid(12), USER, 'a'.repeat(64));
    });
    const response = await get(path); await reject(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each(paths)('rechecks deterministic expiry after middleware at %s', async path => {
    intercept(async () => {}, true);
    const response = await get(path); await reject(response, 401, 'AUTHENTICATION_ERROR');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it.each(paths)('rechecks user deactivation after middleware at %s', async path => {
    intercept(async () => { await sql('UPDATE users SET is_active=0 WHERE id=?', USER); });
    await reject(await get(path), 401, 'AUTHENTICATION_ERROR');
  });
  it('invalid auth has 401 precedence over missing/nonowner/nonuuid 404', async () => {
    await sql('UPDATE user_sessions SET revoked_at=unixepoch() WHERE id=?', sessionId);
    for (const id of [OTHER_RAID, uuid(999), 'invalid']) for (const suffix of ['checks', 'summary']) await reject(await get(`/api/raid-sessions/${id}/${suffix}`), 401, 'AUTHENTICATION_ERROR');
  });
  it('ADMIN demoted before the batch lists only own raids, never stale global permissions', async () => {
    await raid(uuid(105), ADMIN);
    intercept(async () => { await sql("UPDATE users SET role='OFFICER' WHERE id=?", ADMIN); });
    expect((await list(LIST, adminToken)).raid_sessions.map(r => r.id)).toEqual([uuid(105)]);
  });
  it.each(['checks', 'summary'])('ADMIN demoted after middleware cannot read another owner %s', async suffix => {
    intercept(async () => { await sql("UPDATE users SET role='OFFICER' WHERE id=?", ADMIN); });
    const response = await get(`/api/raid-sessions/${OTHER_RAID}/${suffix}`, adminToken);
    await reject(response, 404, 'RAID_SESSION_NOT_FOUND'); expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('OFFICER promotion after middleware may remain narrowed, never broadens middleware permissions', async () => {
    intercept(async () => { await sql("UPDATE users SET role='ADMIN' WHERE id=?", USER); });
    expect((await list()).raid_sessions.map(r => r.id)).toEqual([RAID]);
  });
  it('returns only allowlisted checks, with request ID solely in success headers', async () => {
    await check(1); const response = await get(paths[1]);
    expect(response.status).toBe(200); expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ checks: [{ id: uuid(1001), nopol: 'DH1ZZ', outcome: 'FOUND', tax_status: 'ACTIVE', stnk_status: 'UNKNOWN', source: 'CACHE', checked_at: TIME }], next_cursor: null });
    const raids = await list(); expect(Object.keys(raids).sort()).toEqual(['next_cursor', 'raid_sessions']);
    expect(Object.keys(raids.raid_sessions[0]).sort()).toEqual(['closed_at', 'id', 'lane', 'location', 'owner', 'started_at', 'status']);
    expect(JSON.stringify(raids)).not.toMatch(/password|token|owner_name|idempotency_key|user_id/);
  });
  it('database failure stays generic 500, does not clear a valid cookie or leak SQL', async () => {
    intercept(async () => { throw new Error('FORBIDDEN_SENTINEL SELECT private DH1234ZZ'); });
    const response = await get(LIST); await reject(response, 500, 'INTERNAL_ERROR');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('strict bounded keyset pagination and SQL recap', () => {
  const badQueries = ['limit=', 'limit=0', 'limit=51', 'limit=100', 'limit=-1', 'limit=01', 'limit=1.0', 'limit=1e1', 'limit=%201', 'limit=1&limit=2', 'cursor=', 'cursor=a', 'cursor=abc=', 'cursor='+'a'.repeat(65), 'cursor=a&cursor=b', 'user_id=x', 'sort=asc', 'unknown=', 'limit=20&unknown=1'];
  it.each(badQueries)('rejects invalid/duplicate/unknown query %s', async query => {
    for (const path of paths.slice(0,2)) await reject(await get(`${path}?${query}`), 400, 'INVALID_INPUT');
  });
  const tuples = [`-1.${uuid(1)}`, `01.${uuid(1)}`, `1.5.${uuid(1)}`, `8640000000001.${uuid(1)}`, `9007199254740992.${uuid(1)}`, `1.AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`, '1.not-a-uuid', `1.${uuid(1)}.extra`];
  it.each(tuples)('rejects noncanonical/unsupported cursor tuple %s', async tuple => {
    const cursor = btoa(tuple).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/, '');
    await reject(await get(`${LIST}?cursor=${cursor}`), 400, 'INVALID_INPUT');
  });
  it('rejects noncanonical base64 trailing bits and padding', async () => {
    const canonical = encodeHistoryCursor(1, uuid(1));
    // 38-byte tuple has a spare base64 bit; changing it preserves decoded bytes but is not canonical.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const changed = canonical.slice(0,-1)+alphabet[alphabet.indexOf(canonical.at(-1)!)+1];
    await reject(await get(`${LIST}?cursor=${changed}`), 400, 'INVALID_INPUT');
    await reject(await get(`${LIST}?cursor=${canonical}=`), 400, 'INVALID_INPUT');
  });
  it.each(['limit=1', 'cursor=x', 'unknown=1'])('summary rejects all query parameters: %s', async query => {
    await reject(await get(`${paths[2]}?${query}`), 400, 'INVALID_INPUT');
  });
  it('empty lists/checks use null cursor and summary exact zeros', async () => {
    expect(await checks()).toEqual({ checks: [], next_cursor: null });
    await sql('DELETE FROM raid_sessions WHERE user_id=?', USER);
    expect(await list()).toEqual({ raid_sessions: [], next_cursor: null });
  });
  it('default20/max50 and complete distinct stable tie pages for checks', async () => {
    for (let n=1;n<=55;n++) await check(n);
    const first = await checks(); expect(first.checks).toHaveLength(20);
    expect(first.next_cursor).toBe(encodeHistoryCursor(TIME, uuid(1036)));
    expect((await checks(`${paths[1]}?limit=50`)).checks).toHaveLength(50);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page = await checks(`${paths[1]}?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...page.checks.map(c => c.id)); cursor = page.next_cursor;
    } while (cursor);
    expect(ids).toEqual(Array.from({length:55},(_,n)=>uuid(1055-n))); expect(new Set(ids).size).toBe(55);
    expect((await checks(`${paths[1]}?cursor=${encodeHistoryCursor(0,uuid(1))}`))).toEqual({ checks: [], next_cursor: null });
  });
  it('default20/max50 and stable complete tie pages for own and ADMIN global raids', async () => {
    for (let n=1;n<=54;n++) await raid(uuid(200+n));
    expect((await list()).raid_sessions).toHaveLength(20); expect((await list(`${LIST}?limit=50`)).raid_sessions).toHaveLength(50);
    for (const cookie of [token,adminToken]) {
      const ids: string[] = []; let cursor: string | null = null;
      do {
        const page = await list(`${LIST}?limit=9${cursor ? `&cursor=${cursor}` : ''}`,cookie);
        ids.push(...page.raid_sessions.map(r=>r.id)); cursor = page.next_cursor;
      } while (cursor);
      const expected = [...Array.from({length:54},(_,n)=>uuid(254-n)), ...(cookie===adminToken ? [OTHER_RAID] : []), RAID];
      expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(expected.length);
    }
  });
  it('cursor only bounds position, never grants other owner authority', async () => {
    await check(1,OTHER_RAID,OTHER);
    const cursor = encodeHistoryCursor(TIME+100,uuid(9999));
    expect((await list(`${LIST}?cursor=${cursor}`)).raid_sessions.map(r=>r.id)).toEqual([RAID]);
    await reject(await get(`/api/raid-sessions/${OTHER_RAID}/checks?cursor=${cursor}`),404,'RAID_SESSION_NOT_FOUND');
  });
  it('aggregate partitions FOUND/NOT_FOUND and typed UNKNOWN exactly without fetching all logs', async () => {
    for (const [n,tax] of [[1,'ACTIVE'],[2,'EXPIRED'],[3,'UNKNOWN'],[4,null],[5,'ACTIVE']] as const) await check(n,RAID,USER,tax);
    const duplicate = await db.prepare(`INSERT INTO check_logs(id,raid_session_id,user_id,idempotency_key,nopol,outcome,source,checked_at)
      VALUES(?,?,?,?,'DH1ZZ','NOT_FOUND','LIVE',?) ON CONFLICT(raid_session_id,nopol) DO NOTHING`).bind(uuid(888),RAID,USER,uuid(889),TIME+99).run();
    expect(duplicate.meta.changes).toBe(0);
    const plans: { query: string; bindings: (string|number|null)[] }[] = []; intercept(async()=>{},false,plans);
    const response = await get(paths[2]); expect(response.status).toBe(200);
    const body = await response.json() as {summary: Record<string,number>};
    expect(body.summary).toEqual({total_checks:5,found:4,not_found:1,tax_active:2,tax_expired:1,tax_unknown:1});
    expect(body.summary.total_checks).toBe(body.summary.found+body.summary.not_found);
    expect(body.summary.found).toBe(body.summary.tax_active+body.summary.tax_expired+body.summary.tax_unknown);
    expect(plans.filter(p=>p.query.includes('FROM check_logs'))).toHaveLength(1);
    expect(plans.find(p=>p.query.includes('FROM check_logs'))!.query).toContain('COUNT(*)');
  });
  it('selected production paging queries use supporting indexes without TEMP SORT or full check scans', async () => {
    await check(1);
    const plans: { query: string; bindings: (string|number|null)[] }[] = []; intercept(async()=>{},false,plans);
    await list(`${LIST}?cursor=${encodeHistoryCursor(TIME+1,uuid(999))}`);
    await checks(`${paths[1]}?cursor=${encodeHistoryCursor(TIME+1,uuid(999))}`);
    const paging = plans.filter(p=>p.query.includes('ORDER BY'));
    expect(paging).toHaveLength(3);
    for (const plan of paging) {
      const explained = await db.prepare(`EXPLAIN QUERY PLAN ${plan.query}`).bind(...plan.bindings).all<{detail:string}>();
      const text = explained.results.map((r:{detail:string})=>r.detail).join('\n');
      expect(text).not.toMatch(/TEMP B-TREE|TEMP SORT|SCAN check_logs/);
      expect(text).toMatch(/raid_sessions_user_started_id|raid_sessions_started_id|check_logs_raid_checked_id/);
    }
  });
});
