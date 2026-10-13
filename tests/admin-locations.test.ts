import type { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../shared/password';
import { createApp } from '../worker/index';
import type { AdminLocation } from '../worker/admin';
import { createSafeLogger } from '../worker/logger';
import { generateSessionToken, hashSessionToken } from '../worker/session';
import { resetTestD1, startMigratedD1, type TestD1 } from './helpers/miniflare';

// Real D1/workerd, synthetic data. Fixture hashing is 1000; application config stays 100000/43200.
const ORIGIN = 'https://app.test';
const PASSWORD = 'Synthetic-old-password';
const IDS = { admin: '11111111-1111-4111-8111-111111111111', officer: '33333333-3333-4333-8333-333333333333', missing: '99999999-9999-4999-8999-999999999999' };
const BASE = '/api/admin/locations';
let mf: Miniflare, db: TestD1, app: ReturnType<typeof createApp>, lines: string[], fixtureHash: string;
let tokens: Record<string, string>;
const vars = { PASSWORD_PBKDF2_ITERATIONS: '100000', SESSION_TTL_SECONDS: '43200', RETENTION_POLICY: 'UNSET' };
const sql = (query: string, ...values: (string | number | null)[]) => db.prepare(query).bind(...values).run();
const env = () => ({ DB: db, ...vars }) as unknown as Env;
async function session(userId: string) {
 const id = crypto.randomUUID(); const token = generateSessionToken();
 await sql('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,unixepoch(),unixepoch()+43200)', id, userId, await hashSessionToken(token));
 return token;
}
function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
 return Promise.resolve(app.request(`${ORIGIN}${path}`, { method,
  headers: { Cookie: token === undefined ? '' : `__Host-rs_session=${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body) }, env()));
}
async function error(response: Response, status: number, code: string) {
 expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
 expect(await response.json()).toEqual({ error: { code, message: expect.any(String), request_id: response.headers.get('x-request-id') } });
}
function assertDto(location: AdminLocation) {
 expect(Object.keys(location).sort()).toEqual(['created_at', 'id', 'is_active', 'name', 'updated_at']);
 expect(typeof location.is_active).toBe('boolean'); expect(location.id).toMatch(/^[0-9a-f-]{36}$/);
 expect(typeof location.name).toBe('string');
}
const auditCount = (action: string, locationId: string) =>
 db.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = ? AND target_location_id = ?').bind(action, locationId).first<number>('n');
beforeAll(async () => { ({ mf, db } = await startMigratedD1()); fixtureHash = await hashPassword(PASSWORD, 1000); });
beforeEach(async () => {
 await resetTestD1(db); lines = []; tokens = {};
 app = createApp(createSafeLogger(line => lines.push(line)));
 for (const [name, id] of Object.entries(IDS).filter(([name]) => name !== 'missing')) {
  await sql('INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)', id, `synthetic.${name}`, fixtureHash, name === 'officer' ? 'OFFICER' : 'ADMIN');
  tokens[name] = await session(id);
 }
 // Seed two locations: one active, one inactive.
 await sql(`INSERT INTO locations(id,name,is_active) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Lokasi Aktif',1),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Lokasi Nonaktif',0)`);
});
afterAll(async () => { await mf?.dispose(); });

describe('admin locations CRUD', () => {
 it('lists all locations with allowlisted DTO fields, ordered by name', async () => {
  const result = await call('GET', BASE, undefined, tokens.admin);
  expect(result.status).toBe(200);
  const body = await result.json() as { locations: AdminLocation[] };
  expect(body.locations).toHaveLength(2); body.locations.forEach(assertDto);
  expect(body.locations.map(l => l.name)).toEqual(['Lokasi Aktif', 'Lokasi Nonaktif']);
  expect(body.locations.find(l => l.name === 'Lokasi Nonaktif')?.is_active).toBe(false);
 });
 it.each([
  ['no token', 'GET', undefined, undefined, 401, 'AUTHENTICATION_ERROR'],
  ['officer token', 'GET', undefined, 'officer', 403, 'AUTHORIZATION_ERROR'],
  ['officer create', 'POST', { name: 'X' }, 'officer', 403, 'AUTHORIZATION_ERROR'],
  ['officer patch', 'PATCH', { name: 'X' }, 'officer', 403, 'AUTHORIZATION_ERROR'],
  ['officer delete', 'DELETE', {}, 'officer', 403, 'AUTHORIZATION_ERROR'],
 ] as const)('rejects %s', async (_label, method, body, role, status, code) => {
  const target = method === 'GET' || method === 'POST' ? BASE : `${BASE}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  await error(await call(method, target, body, role === undefined ? undefined : tokens[role]), status, code);
 });
 it('creates a location, trims the name, and audits LOCATION_CREATED', async () => {
  const result = await call('POST', BASE, { name: '  Jln. El Tari  ' }, tokens.admin);
  expect(result.status).toBe(201);
  const location = await result.json() as AdminLocation; assertDto(location);
  expect(location.name).toBe('Jln. El Tari'); expect(location.is_active).toBe(true);
  expect(await auditCount('LOCATION_CREATED', location.id)).toBe(1);
  const listed = await (await call('GET', BASE, undefined, tokens.admin)).json() as { locations: AdminLocation[] };
  expect(listed.locations.map(l => l.name)).toContain('Jln. El Tari');
 });
 it.each([[null], [''], ['   '], ['x'.repeat(201)], [123], [{}]])('rejects invalid create name %j', async (name: unknown) => {
  await error(await call('POST', BASE, { name }, tokens.admin), 400, 'INVALID_INPUT');
 });
 it.each([{}, { name: 'A', extra: 1 }, { name: 'A', is_active: true }])('rejects create body with wrong keys %j', async body => {
  await error(await call('POST', BASE, body, tokens.admin), 400, 'INVALID_INPUT');
 });
 it('renames a location and audits LOCATION_UPDATED', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const result = await call('PATCH', `${BASE}/${id}`, { name: 'Nama Baru' }, tokens.admin);
  expect(result.status).toBe(200);
  const location = await result.json() as AdminLocation; assertDto(location);
  expect(location.name).toBe('Nama Baru'); expect(location.is_active).toBe(true);
  expect(await auditCount('LOCATION_UPDATED', id)).toBe(1);
 });
 it('reactivates an inactive location via PATCH', async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const result = await call('PATCH', `${BASE}/${id}`, { is_active: true }, tokens.admin);
  expect(result.status).toBe(200);
  expect(((await result.json()) as AdminLocation).is_active).toBe(true);
  // Reactivated locations reappear in the public setup list.
  const publicList = await (await call('GET', '/api/locations', undefined, tokens.officer)).json() as { locations: { id: string }[] };
  expect(publicList.locations.map(l => l.id)).toContain(id);
 });
 it.each([[{}], [{ wrong: 1 }], [{ name: '' }], [{ name: 'x'.repeat(201) }], [{ is_active: 'yes' }], [{ is_active: 1 }]])('rejects invalid patch body %j', async body => {
  await error(await call('PATCH', `${BASE}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, body, tokens.admin), 400, 'INVALID_INPUT');
 });
 it.each([[`${BASE}/${IDS.missing}`, 404, 'LOCATION_NOT_FOUND'], [`${BASE}/not-a-uuid`, 404, 'LOCATION_NOT_FOUND']])('patch %s -> %i %s', async (path, status, code) => {
  await error(await call('PATCH', path, { name: 'X' }, tokens.admin), status, code);
 });
 it('soft-deletes a location, audits LOCATION_DEACTIVATED, and hides it from the public list', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const result = await call('DELETE', `${BASE}/${id}`, {}, tokens.admin);
  expect(result.status).toBe(200);
  const location = await result.json() as AdminLocation; assertDto(location);
  expect(location.is_active).toBe(false);
  expect(await auditCount('LOCATION_DEACTIVATED', id)).toBe(1);
  // Admin list still shows it; the officer setup list no longer does.
  const adminList = await (await call('GET', BASE, undefined, tokens.admin)).json() as { locations: AdminLocation[] };
  expect(adminList.locations.find(l => l.id === id)?.is_active).toBe(false);
  const publicList = await (await call('GET', '/api/locations', undefined, tokens.officer)).json() as { locations: { id: string }[] };
  expect(publicList.locations.map(l => l.id)).not.toContain(id);
 });
 it('delete is idempotent: second call succeeds without a new audit row', async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // already inactive
  const result = await call('DELETE', `${BASE}/${id}`, {}, tokens.admin);
  expect(result.status).toBe(200);
  expect(((await result.json()) as AdminLocation).is_active).toBe(false);
  expect(await auditCount('LOCATION_DEACTIVATED', id)).toBe(0);
 });
 it.each([[`${BASE}/${IDS.missing}`, 404, 'LOCATION_NOT_FOUND'], [`${BASE}/not-a-uuid`, 404, 'LOCATION_NOT_FOUND']])('delete %s -> %i %s', async (path, status, code) => {
  await error(await call('DELETE', path, {}, tokens.admin), status, code);
 });
 it('keeps raid history intact after its location is deactivated', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await sql(`INSERT INTO raid_sessions(id,user_id,location_id,lane,status,started_at) VALUES(?,?,?,?,?,unixepoch())`,
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc', IDS.admin, id, 'A', 'CLOSED');
  await call('DELETE', `${BASE}/${id}`, {}, tokens.admin);
  const row = await db.prepare('SELECT location_id FROM raid_sessions WHERE id = ?').bind('cccccccc-cccc-4ccc-8ccc-cccccccccccc').first<{ location_id: string }>('location_id');
  expect(row?.location_id).toBe(id);
 });
});
