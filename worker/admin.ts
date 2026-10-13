import type { Context } from 'hono';
import { AppError } from '../shared/errors';
import { hashPassword, isAcceptablePassword } from '../shared/password';
import { normalizeUsername } from '../shared/username';
import { readAuthConfig } from './config';
import { pageResult, readPage } from './history';
import { errorMessageIncludes, readJsonObject } from './http';
import { isUuid } from './raids';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App, AppEnv, Role } from './types';

export type AdminUser = { id: string; username: string; role: Role; is_active: boolean; created_at: number; updated_at: number; active_session_count: number };
type UserRow = Omit<AdminUser, 'is_active'> & { is_active: number };
type SessionRow = { id: string; created_at: number; expires_at: number; is_current: number };
export type AdminLocation = { id: string; name: string; is_active: boolean; created_at: number; updated_at: number };
type LocationRow = Omit<AdminLocation, 'is_active'> & { is_active: number };
const LOCATION_FIELDS = 'id, name, is_active, created_at, updated_at';
const toLocation = (row: LocationRow): AdminLocation => ({ id: row.id, name: row.name, is_active: row.is_active === 1,
 created_at: row.created_at, updated_at: row.updated_at });
function locationTarget(c: Context<AppEnv>, id: string): D1PreparedStatement {
 return statement(c, `SELECT ${LOCATION_FIELDS} FROM locations WHERE id = ? AND EXISTS (${ADMIN})`, id, ...bindings(c));
}
function locationFrom(result: D1Result): AdminLocation {
 const row = result.results[0] as LocationRow | undefined;
 if (!row) throw new AppError('LOCATION_NOT_FOUND');
 return toLocation(row);
}
// Audit trail for location mutations binds target_location_id (never target_user_id).
function auditLocation(c: Context<AppEnv>, auditId: string, action: string, locationId: string, condition: string, values: (string | number)[] = []): D1PreparedStatement {
 return statement(c, `INSERT INTO admin_audit_logs(id,actor_user_id,action,target_location_id)
 SELECT ?, ?, ?, ? WHERE EXISTS (${ADMIN}) AND (${condition})`, auditId, currentAuth(c).userId, action, locationId, ...bindings(c), ...values);
}
const normalizeLocationName = (value: unknown): string | null => {
 if (typeof value !== 'string') return null;
 const name = value.trim();
 return name.length >= 1 && name.length <= 200 ? name : null;
};
// Bind exact server-authenticated identity. A second device cannot authorize a stale request.
const AUTH = `SELECT u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
 WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()
 AND u.is_active = 1 AND u.role IN ('ADMIN','OFFICER')`;
const ADMIN = `SELECT 1 FROM (${AUTH}) WHERE role = 'ADMIN'`;
const FIELDS = `u.id, u.username, u.role, u.is_active, u.created_at, u.updated_at,
 (SELECT COUNT(*) FROM user_sessions t WHERE t.user_id = u.id AND t.revoked_at IS NULL AND t.expires_at > unixepoch()) AS active_session_count`;
const toUser = (row: UserRow): AdminUser => ({ id: row.id, username: row.username, role: row.role, is_active: row.is_active === 1,
 created_at: row.created_at, updated_at: row.updated_at, active_session_count: row.active_session_count });
function bindings(c: Context<AppEnv>): [string, string] { const auth = currentAuth(c); return [auth.sessionId, auth.userId]; }
function statement(c: Context<AppEnv>, sql: string, ...values: (string | number)[]): D1PreparedStatement { return c.env.DB.prepare(sql).bind(...values); }
function authorization(c: Context<AppEnv>): D1PreparedStatement { return statement(c, AUTH, ...bindings(c)); }
function target(c: Context<AppEnv>, id: string): D1PreparedStatement {
 return statement(c, `SELECT ${FIELDS} FROM users u WHERE u.id = ? AND EXISTS (${ADMIN})`, id, ...bindings(c));
}
function assertActor(c: Context<AppEnv>, result: D1Result): void {
 const actor = result.results[0] as { role: Role } | undefined;
 if (!actor) { clearSessionCookie(c); throw new AppError('AUTHENTICATION_ERROR'); }
 if (actor.role !== 'ADMIN') throw new AppError('AUTHORIZATION_ERROR');
}
function userFrom(result: D1Result, sessionRoute = false): AdminUser {
 const row = result.results[0] as UserRow | undefined;
 if (!row) throw new AppError(sessionRoute ? 'SESSION_NOT_FOUND' : 'USER_NOT_FOUND');
 return toUser(row);
}
async function exactBody(c: Context<AppEnv>, keys: string[]): Promise<Record<string, unknown>> {
 readPage(c, false);
 const body = await readJsonObject(c);
 if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw new AppError('INVALID_INPUT');
 return body;
}
const targetId = (c: Context<AppEnv>): string => { const id = c.req.param('id'); return isUuid(id) ? id : ''; };
// Expensive password work starts only after middleware and a fresh guarded SQL preflight.
async function preflight(c: Context<AppEnv>, id?: string): Promise<void> {
 const results = await c.env.DB.batch([authorization(c), ...(id === undefined ? [] : [target(c, id)])]);
 assertActor(c, results[0]);
 if (id !== undefined) userFrom(results[1]);
}
function audit(c: Context<AppEnv>, auditId: string, action: string, id: string, condition: string, values: (string | number)[] = [], session = false): D1PreparedStatement {
 return statement(c, `INSERT INTO admin_audit_logs(id,actor_user_id,action,${session ? 'target_session_id' : 'target_user_id'})
 SELECT ?, ?, ?, ? WHERE EXISTS (${ADMIN}) AND (${condition})`, auditId, currentAuth(c).userId, action, id, ...bindings(c), ...values);
}

export function registerAdminRoutes(app: App): void {
 app.get('/api/admin/users', requireAuth(), requireRole('ADMIN'), async c => {
  const page = readPage(c);
  const [actor, data] = await c.env.DB.batch([authorization(c), statement(c, `SELECT ${FIELDS} FROM users u
   WHERE EXISTS (${ADMIN}) ${page.cursor ? 'AND (u.created_at,u.id) < (?,?)' : ''}
   ORDER BY u.created_at DESC,u.id DESC LIMIT ?`, ...bindings(c), ...(page.cursor ? [page.cursor.epoch, page.cursor.id] : []), page.limit + 1)]);
  assertActor(c, actor);
  const result = pageResult(data.results as UserRow[], page, row => ({ epoch: row.created_at, id: row.id }));
  return c.json({ users: result.rows.map(toUser), next_cursor: result.next_cursor });
 });
 app.get('/api/admin/users/:id', requireAuth(), requireRole('ADMIN'), async c => {
  readPage(c, false);
  const [actor, user] = await c.env.DB.batch([authorization(c), target(c, targetId(c))]);
  assertActor(c, actor);
  return c.json(userFrom(user));
 });
 app.post('/api/admin/users', requireAuth(), requireRole('ADMIN'), async c => {
  const body = await exactBody(c, ['username','password','role']);
  const username = normalizeUsername(body.username);
  if (!username || !isAcceptablePassword(body.password) || (body.role !== 'ADMIN' && body.role !== 'OFFICER')) throw new AppError('INVALID_INPUT');
  await preflight(c);
  const hash = await hashPassword(body.password, readAuthConfig(c.env).passwordIterations);
  const id = crypto.randomUUID(); const auditId = crypto.randomUUID();
  let results: D1Result[];
  try {
   results = await c.env.DB.batch([authorization(c),
    statement(c, `INSERT INTO users(id,username,password_hash,role) SELECT ?,?,?,? WHERE EXISTS (${ADMIN})`, id, username, hash, body.role, ...bindings(c)),
    audit(c, auditId, 'USER_CREATED', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)', [id,hash]), target(c, id)]);
  } catch (error) {
   if (errorMessageIncludes(error, 'UNIQUE constraint failed: users.username')) throw new AppError('USERNAME_TAKEN');
   throw error;
  }
  assertActor(c, results[0]);
  return c.json(userFrom(results[3]), 201);
 });
 for (const active of [true,false]) {
  app.post(`/api/admin/users/:id/${active ? 'activate' : 'deactivate'}`, requireAuth(), requireRole('ADMIN'), async c => {
   await exactBody(c, []);
   const id = targetId(c); const auth = currentAuth(c);
    const [actor, before, , , selected] = await c.env.DB.batch([authorization(c), target(c, id),
    statement(c, `UPDATE users SET is_active = ?,updated_at = max(unixepoch(),created_at)
     WHERE id = ? AND is_active <> ? ${active ? '' : 'AND id <> ?'} AND EXISTS (${ADMIN})`, Number(active), id, Number(active), ...(active ? [] : [auth.userId]), ...bindings(c)),
    audit(c, crypto.randomUUID(), active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_active = ?)', [id,Number(active)]), target(c, id)]);
   assertActor(c, actor); userFrom(before);
   if (!active && id === auth.userId) throw new AppError('SELF_DEACTIVATION_FORBIDDEN');
   return c.json(userFrom(selected));
  });
 }
 app.post('/api/admin/users/:id/password', requireAuth(), requireRole('ADMIN'), async c => {
  const body = await exactBody(c, ['password']);
  if (!isAcceptablePassword(body.password)) throw new AppError('INVALID_INPUT');
  const id = targetId(c); await preflight(c, id);
  const hash = await hashPassword(body.password, readAuthConfig(c.env).passwordIterations);
  const auditId = crypto.randomUUID();
  const [actor, before, updated, logged, selected] = await c.env.DB.batch([authorization(c), target(c, id),
   statement(c, `UPDATE users SET password_hash = ?,updated_at = max(unixepoch(),created_at) WHERE id = ? AND EXISTS (${ADMIN})`, hash, id, ...bindings(c)),
   // changes() and the exact new hash bind the audit to this mutation, never a stale/no-op proof.
   audit(c, auditId, 'USER_PASSWORD_RESET', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)', [id,hash]), target(c, id),
   // Capture response while actor is still active. Revocation is intentionally last, including self.
   statement(c, `UPDATE user_sessions SET revoked_at = max(unixepoch(),created_at) WHERE user_id = ? AND revoked_at IS NULL
    AND EXISTS (${ADMIN}) AND EXISTS (SELECT 1 FROM admin_audit_logs WHERE id = ? AND target_user_id = ? AND action = 'USER_PASSWORD_RESET')
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`, id, ...bindings(c), auditId,id,id,hash)]);
  assertActor(c, actor); userFrom(before);
  if (updated.meta.changes !== 1 || logged.meta.changes !== 1) throw new AppError('INTERNAL_ERROR');
  const user = userFrom(selected); user.active_session_count = 0;
  const signed_out = id === currentAuth(c).userId;
  if (signed_out) clearSessionCookie(c);
  return c.json({ user, signed_out });
 });
 app.get('/api/admin/users/:id/sessions', requireAuth(), requireRole('ADMIN'), async c => {
  const page = readPage(c); const id = targetId(c);
  const [actor, user, data] = await c.env.DB.batch([authorization(c), target(c, id),
   statement(c, `SELECT t.id,t.created_at,t.expires_at,(t.id = ?) AS is_current FROM user_sessions t
    WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.expires_at > unixepoch() AND EXISTS (${ADMIN})
    ${page.cursor ? 'AND (t.created_at,t.id) < (?,?)' : ''} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`,
    currentAuth(c).sessionId,id,...bindings(c),...(page.cursor ? [page.cursor.epoch,page.cursor.id] : []),page.limit + 1)]);
  assertActor(c, actor); userFrom(user, true);
  const result = pageResult(data.results as SessionRow[], page, row => ({ epoch: row.created_at,id: row.id }));
  return c.json({ sessions: result.rows.map(row => ({ id: row.id,created_at: row.created_at,expires_at: row.expires_at,is_current: row.is_current === 1 })), next_cursor: result.next_cursor });
 });
 app.post('/api/admin/users/:id/sessions/revoke', requireAuth(), requireRole('ADMIN'), async c => {
  readPage(c, false); const body = await readJsonObject(c);
  const keys = Object.keys(body);
  if (keys.length > 1 || (keys.length === 1 && (keys[0] !== 'session_id' || typeof body.session_id !== 'string'))) throw new AppError('INVALID_INPUT');
  const specific = keys.length === 1; const sessionId = isUuid(body.session_id) ? body.session_id : '';
  const id = targetId(c); const auditId = crypto.randomUUID();
  const sessionFilter = specific ? 'AND t.id = ?' : '';
  const sessionValues = specific ? [sessionId] : [];
  const [actor, selected, owned, logged, revoked] = await c.env.DB.batch([authorization(c), target(c, id),
   statement(c, `SELECT t.id FROM user_sessions t WHERE t.user_id = ? ${sessionFilter} AND EXISTS (${ADMIN}) LIMIT 1`, id,...sessionValues,...bindings(c)),
   audit(c, auditId, specific ? 'SESSION_REVOKED' : 'USER_SESSIONS_REVOKED', specific ? sessionId : id,
    `EXISTS (SELECT 1 FROM user_sessions t WHERE t.user_id = ? ${sessionFilter} AND t.revoked_at IS NULL AND t.expires_at > unixepoch())`, [id,...sessionValues],specific),
   statement(c, `UPDATE user_sessions SET revoked_at = max(unixepoch(),created_at) WHERE user_id = ? ${specific ? 'AND id = ?' : ''}
    AND revoked_at IS NULL AND EXISTS (${ADMIN}) AND EXISTS (SELECT 1 FROM admin_audit_logs WHERE id = ?)`, id,...sessionValues,...bindings(c),auditId)]);
  assertActor(c, actor); const user = userFrom(selected, true);
  if (specific && !owned.results.length) throw new AppError('SESSION_NOT_FOUND');
  if (logged.meta.changes === 1) user.active_session_count = specific ? Math.max(0,user.active_session_count - 1) : 0;
  const signed_out = revoked.meta.changes > 0 && id === currentAuth(c).userId && (!specific || sessionId === currentAuth(c).sessionId);
  if (signed_out) clearSessionCookie(c);
  return c.json({ user,signed_out });
 });
 // --- Location management (ADMIN only). Delete is a soft delete: raid history keeps its FK target.
 app.get('/api/admin/locations', requireAuth(), requireRole('ADMIN'), async c => {
  readPage(c, false);
  const [actor, data] = await c.env.DB.batch([authorization(c),
   statement(c, `SELECT ${LOCATION_FIELDS} FROM locations WHERE EXISTS (${ADMIN}) ORDER BY name COLLATE NOCASE, id`, ...bindings(c))]);
  assertActor(c, actor);
  return c.json({ locations: (data.results as LocationRow[]).map(toLocation) });
 });
 app.post('/api/admin/locations', requireAuth(), requireRole('ADMIN'), async c => {
  const body = await exactBody(c, ['name']);
  const name = normalizeLocationName(body.name);
  if (name === null) throw new AppError('INVALID_INPUT');
  await preflight(c);
  const id = crypto.randomUUID(); const auditId = crypto.randomUUID();
  const results = await c.env.DB.batch([authorization(c),
   statement(c, `INSERT INTO locations(id,name) SELECT ?,? WHERE EXISTS (${ADMIN})`, id, name, ...bindings(c)),
   auditLocation(c, auditId, 'LOCATION_CREATED', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM locations WHERE id = ? AND name = ?)', [id,name]),
   locationTarget(c, id)]);
  assertActor(c, results[0]);
  return c.json(locationFrom(results[3]), 201);
 });
 app.patch('/api/admin/locations/:id', requireAuth(), requireRole('ADMIN'), async c => {
  const body = await readJsonObject(c);
  const keys = Object.keys(body);
  const allowed = ['name','is_active'];
  if (keys.length < 1 || keys.some(key => !allowed.includes(key))) throw new AppError('INVALID_INPUT');
  const name = 'name' in body ? normalizeLocationName(body.name) : undefined;
  const active = 'is_active' in body ? body.is_active : undefined;
  if ((name === null) || (active !== undefined && typeof active !== 'boolean')) throw new AppError('INVALID_INPUT');
  const id = targetId(c); await preflight(c);
  const sets: string[] = []; const values: (string | number)[] = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (active !== undefined) { sets.push('is_active = ?'); values.push(Number(active)); }
  const auditId = crypto.randomUUID();
  const results = await c.env.DB.batch([authorization(c), locationTarget(c, id),
   statement(c, `UPDATE locations SET ${sets.join(', ')},updated_at = max(unixepoch(),created_at)
    WHERE id = ? AND EXISTS (${ADMIN})`, ...values, id, ...bindings(c)),
   // Bind the audit to this exact mutation: only a real change is logged.
   auditLocation(c, auditId, 'LOCATION_UPDATED', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM locations WHERE id = ?)', [id]),
   locationTarget(c, id)]);
  assertActor(c, results[0]); locationFrom(results[1]);
  return c.json(locationFrom(results[4]));
 });
 app.delete('/api/admin/locations/:id', requireAuth(), requireRole('ADMIN'), async c => {
  await exactBody(c, []);
  const id = targetId(c); const auditId = crypto.randomUUID();
  const [actor, before, updated, logged, selected] = await c.env.DB.batch([authorization(c), locationTarget(c, id),
   statement(c, `UPDATE locations SET is_active = 0,updated_at = max(unixepoch(),created_at)
    WHERE id = ? AND is_active = 1 AND EXISTS (${ADMIN})`, id, ...bindings(c)),
   auditLocation(c, auditId, 'LOCATION_DEACTIVATED', id, 'changes() = 1 AND EXISTS (SELECT 1 FROM locations WHERE id = ? AND is_active = 0)', [id]),
   locationTarget(c, id)]);
  assertActor(c, actor); locationFrom(before);
  return c.json(locationFrom(selected));
 });
}
