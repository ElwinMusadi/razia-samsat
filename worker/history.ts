import type { Context } from 'hono';
import { AppError } from '../shared/errors';
import { isUuid, type RaidSession } from './raids';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App, AppEnv } from './types';

export type HistoryRaid = RaidSession & { owner: { id: string; username: string } };
export type HistoryCheck = { id: string; nopol: string; outcome: 'FOUND' | 'NOT_FOUND'; tax_status: 'ACTIVE' | 'EXPIRED' | 'UNKNOWN' | null; stnk_status: 'ACTIVE' | 'EXPIRED' | 'UNKNOWN' | null; source: 'LIVE' | 'CACHE'; checked_at: number };
type RaidRow = { id: string; lane: string; status: 'ACTIVE' | 'CLOSED'; started_at: number; closed_at: number | null; location_id: string; location_name: string; owner_id: string; owner_username: string };
type Cursor = { epoch: number; id: string };
type Page = { limit: number; cursor: Cursor | null };
// Maximum supported JavaScript Date instant in epoch seconds, also safely represented as an integer.
const MAX_EPOCH = 8640000000000;

export function encodeHistoryCursor(epoch: number, id: string): string {
  return btoa(`${epoch}.${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(value: string): Cursor {
  if (value.length > 64 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError('INVALID_INPUT');
  let tuple: string;
  try { tuple = atob(value.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new AppError('INVALID_INPUT'); }
  const match = /^(0|[1-9]\d*)\.([0-9a-f-]{36})$/.exec(tuple);
  if (!match) throw new AppError('INVALID_INPUT');
  const epoch = Number(match[1]); const id = match[2];
  if (!Number.isSafeInteger(epoch) || epoch > MAX_EPOCH || !isUuid(id) || encodeHistoryCursor(epoch, id) !== value) throw new AppError('INVALID_INPUT');
  return { epoch, id };
}

export function readPage(c: Context<AppEnv>, paged = true): Page {
  const params = new URL(c.req.url).searchParams;
  for (const key of params.keys()) {
    if (!paged || !['limit', 'cursor'].includes(key) || params.getAll(key).length !== 1 || params.get(key) === '') throw new AppError('INVALID_INPUT');
  }
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) throw new AppError('INVALID_INPUT');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (limit > 50) throw new AppError('INVALID_INPUT');
  const rawCursor = params.get('cursor');
  return { limit, cursor: rawCursor === null ? null : decodeCursor(rawCursor) };
}

// Exact cookie session and current database policy participate in every data statement.
// A middleware OFFICER promoted during the request stays narrowed to own raids.
const AUTH = `SELECT s.user_id, CASE WHEN u.role = 'ADMIN' AND ? = 'ADMIN' THEN 'ADMIN' ELSE 'OFFICER' END AS role
  FROM user_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()
  AND u.is_active = 1 AND u.role IN ('ADMIN', 'OFFICER')`;
const RAID_FIELDS = `r.id, r.lane, r.status, r.started_at, r.closed_at, l.id AS location_id, l.name AS location_name,
  u.id AS owner_id, u.username AS owner_username`;
const RAID_JOINS = `JOIN locations l ON l.id = r.location_id JOIN users u ON u.id = r.user_id`;
const TARGET = `SELECT r.id FROM raid_sessions r JOIN auth a ON (a.role = 'ADMIN' OR r.user_id = a.user_id) WHERE r.id = ?`;

function toRaid(row: RaidRow): HistoryRaid {
  return { id: row.id, location: { id: row.location_id, name: row.location_name }, lane: row.lane, status: row.status,
    started_at: row.started_at, closed_at: row.closed_at, owner: { id: row.owner_id, username: row.owner_username } };
}
function assertAuth(c: Context<AppEnv>, result: D1Result): void {
  if (!result.results.length) { clearSessionCookie(c); throw new AppError('AUTHENTICATION_ERROR'); }
}
export function pageResult<T>(rows: T[], page: Page, tuple: (row: T) => Cursor): { rows: T[]; next_cursor: string | null } {
  const selected = rows.slice(0, page.limit);
  const last = selected[selected.length - 1];
  const cursor = rows.length > page.limit && last ? tuple(last) : null;
  return { rows: selected, next_cursor: cursor ? encodeHistoryCursor(cursor.epoch, cursor.id) : null };
}

export function registerHistoryRoutes(app: App): void {
  app.get('/api/history/raid-sessions', requireAuth(), requireRole('ADMIN', 'OFFICER'), async c => {
    const auth = currentAuth(c); const page = readPage(c); const db = c.env.DB;
    const bindings = [auth.role, auth.sessionId, auth.userId];
    const boundary = page.cursor ? 'AND (r.started_at, r.id) < (?, ?)' : '';
    const tail = page.cursor ? [page.cursor.epoch, page.cursor.id, page.limit + 1] : [page.limit + 1];
    // Separate indexed own/global paths. Current DB demotion cannot broaden the global path.
    const [authorized, own, global] = await db.batch([
      db.prepare(AUTH).bind(...bindings),
      db.prepare(`WITH auth AS (${AUTH}) SELECT ${RAID_FIELDS} FROM raid_sessions r ${RAID_JOINS}
        WHERE r.user_id = ? AND EXISTS (SELECT 1 FROM auth WHERE role = 'OFFICER') ${boundary}
        ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).bind(...bindings, auth.userId, ...tail),
      db.prepare(`WITH auth AS (${AUTH}) SELECT ${RAID_FIELDS} FROM raid_sessions r ${RAID_JOINS}
        WHERE EXISTS (SELECT 1 FROM auth WHERE role = 'ADMIN') ${boundary}
        ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).bind(...bindings, ...tail),
    ]);
    assertAuth(c, authorized);
    const result = pageResult([...own.results, ...global.results] as RaidRow[], page, row => ({ epoch: row.started_at, id: row.id }));
    return c.json({ raid_sessions: result.rows.map(toRaid), next_cursor: result.next_cursor });
  });

  for (const kind of ['checks', 'summary'] as const) {
    app.get(`/api/raid-sessions/:id/${kind}`, requireAuth(), requireRole('ADMIN', 'OFFICER'), async c => {
      const auth = currentAuth(c); const page = readPage(c, kind === 'checks'); const db = c.env.DB;
      const rawId = c.req.param('id'); const id = isUuid(rawId) ? rawId : '';
      const bindings = [auth.role, auth.sessionId, auth.userId];
      const prefix = `WITH auth AS (${AUTH}), target AS (${TARGET})`;
      const statement = kind === 'checks'
        ? db.prepare(`${prefix} SELECT id, nopol, outcome, tax_status, stnk_status, source, checked_at FROM check_logs
          WHERE raid_session_id = ? AND EXISTS (SELECT 1 FROM target) ${page.cursor ? 'AND (checked_at, id) < (?, ?)' : ''}
          ORDER BY checked_at DESC, id DESC LIMIT ?`).bind(...bindings, id, id, ...(page.cursor ? [page.cursor.epoch, page.cursor.id] : []), page.limit + 1)
        : db.prepare(`${prefix} SELECT COUNT(*) AS total_checks,
          COALESCE(SUM(outcome = 'FOUND'), 0) AS found, COALESCE(SUM(outcome = 'NOT_FOUND'), 0) AS not_found,
          COALESCE(SUM(tax_status = 'ACTIVE'), 0) AS tax_active, COALESCE(SUM(tax_status = 'EXPIRED'), 0) AS tax_expired,
          COALESCE(SUM(tax_status = 'UNKNOWN'), 0) AS tax_unknown FROM check_logs
          WHERE raid_session_id = ? AND EXISTS (SELECT 1 FROM target)`).bind(...bindings, id, id);
      const [authorized, raid, data] = await db.batch([
        db.prepare(AUTH).bind(...bindings),
        db.prepare(`WITH auth AS (${AUTH}) SELECT ${RAID_FIELDS} FROM raid_sessions r ${RAID_JOINS}
          JOIN auth a ON (a.role = 'ADMIN' OR r.user_id = a.user_id) WHERE r.id = ?`).bind(...bindings, id),
        statement,
      ]);
      assertAuth(c, authorized);
      const row = raid.results[0] as RaidRow | undefined;
      if (!row) throw new AppError('RAID_SESSION_NOT_FOUND');
      if (kind === 'summary') return c.json({ raid_session: toRaid(row), summary: data.results[0] });
      const result = pageResult(data.results as HistoryCheck[], page, check => ({ epoch: check.checked_at, id: check.id }));
      return c.json({ checks: result.rows, next_cursor: result.next_cursor });
    });
  }
}
