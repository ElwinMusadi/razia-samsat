import { AppError } from '../shared/errors';
import { errorMessageIncludes, readJsonObject } from './http';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App } from './types';

export const LANE_MAX_CODE_POINTS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Control characters, lone surrogates and bidirectional formatting/override characters.
const FORBIDDEN_LANE_CHARACTERS = /[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Timestamps are integer Unix epoch seconds (UTC) taken from the D1 clock. */
export type RaidSession = { id: string; location: { id: string; name: string }; lane: string; status: 'ACTIVE' | 'CLOSED'; started_at: number; closed_at: number | null };
type RaidRow = { id: string; lane: string; status: 'ACTIVE' | 'CLOSED'; started_at: number; closed_at: number | null; location_id: string; location_name: string };

// Bind only the server-authenticated session ID and user ID. Another live session for the same
// user cannot authorize this request. Re-evaluate current account policy inside each mutation.
const RAID_SESSION_AUTH = `SELECT 1 FROM user_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()
  AND u.is_active = 1 AND u.role IN ('ADMIN', 'OFFICER')`;

const RAID_SELECT = `SELECT r.id, r.lane, r.status, r.started_at, r.closed_at, l.id AS location_id, l.name AS location_name
  FROM raid_sessions r JOIN locations l ON l.id = r.location_id`;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** P2-07 lane rule: trim, 1..100 code points, no control/bidi characters. Returns null when invalid. */
export function normalizeLane(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const lane = value.trim();
  const codePoints = [...lane].length;
  if (codePoints < 1 || codePoints > LANE_MAX_CODE_POINTS || FORBIDDEN_LANE_CHARACTERS.test(lane)) return null;
  return lane;
}

function toRaidSession(row: RaidRow): RaidSession {
  return { id: row.id, location: { id: row.location_id, name: row.location_name }, lane: row.lane, status: row.status, started_at: row.started_at, closed_at: row.closed_at };
}

export async function findActiveRaidSession(db: D1Database, userId: string): Promise<RaidSession | null> {
  const row = await db.prepare(`${RAID_SELECT} WHERE r.user_id = ? AND r.status = 'ACTIVE'`).bind(userId).first<RaidRow>();
  return row ? toRaidSession(row) : null;
}

export function registerRaidRoutes(app: App): void {
  app.get('/api/locations', requireAuth(), async c => {
    const { results } = await c.env.DB.prepare('SELECT id, name FROM locations WHERE is_active = 1 ORDER BY name COLLATE NOCASE, id').all<{ id: string; name: string }>();
    return c.json({ locations: results.map(row => ({ id: row.id, name: row.name })) });
  });

  app.get('/api/raid-sessions/active', requireAuth(), async c => {
    return c.json({ active_raid_session: await findActiveRaidSession(c.env.DB, currentAuth(c).userId) });
  });

  // OFFICER and ADMIN may each open a raid session they own (Blueprint sitemap /razia/setup).
  app.post('/api/raid-sessions', requireAuth(), requireRole('OFFICER', 'ADMIN'), async c => {
    const auth = currentAuth(c);
    const body = await readJsonObject(c);
    const lane = normalizeLane(body.lane);
    if (typeof body.location_id !== 'string' || lane === null) throw new AppError('INVALID_INPUT');
    const id = crypto.randomUUID();
    let results: D1Result[];
    try {
      results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO raid_sessions(id, user_id, location_id, lane, status, started_at)
          SELECT ?, ?, id, ?, 'ACTIVE', unixepoch() FROM locations
          WHERE id = ? AND is_active = 1 AND EXISTS (${RAID_SESSION_AUTH})`)
          .bind(id, auth.userId, lane, isUuid(body.location_id) ? body.location_id : '', auth.sessionId, auth.userId),
        c.env.DB.prepare(`SELECT EXISTS (${RAID_SESSION_AUTH}) AS authorized`).bind(auth.sessionId, auth.userId),
        c.env.DB.prepare(`${RAID_SELECT} WHERE r.id = ? AND r.user_id = ?`).bind(id, auth.userId),
      ]);
    } catch (error) {
      // The INSERT can reach this constraint only after its atomic auth/location guards pass.
      if (errorMessageIncludes(error, 'UNIQUE constraint failed: raid_sessions.user_id')) throw new AppError('RAID_SESSION_ALREADY_ACTIVE');
      throw error;
    }
    if (results[0].meta.changes !== 1) {
      if (!(results[1].results as { authorized: number }[])[0]?.authorized) {
        clearSessionCookie(c);
        throw new AppError('AUTHENTICATION_ERROR');
      }
      throw new AppError('LOCATION_UNAVAILABLE');
    }
    // A later revocation must not hide an already committed mutation. Use only this batch's results.
    const row = (results[2].results as RaidRow[])[0];
    if (!row) throw new AppError('INTERNAL_ERROR');
    return c.json(toRaidSession(row), 201);
  });

  // Owner-only and idempotent: an already closed session owned by the caller returns 200 unchanged.
  app.post('/api/raid-sessions/:id/close', requireAuth(), requireRole('OFFICER', 'ADMIN'), async c => {
    const auth = currentAuth(c);
    const id = c.req.param('id');
    const raidId = isUuid(id) ? id : '';
    const [updated, authorization, selected] = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE raid_sessions SET status = 'CLOSED', closed_at = max(unixepoch(), started_at)
        WHERE id = ? AND user_id = ? AND status = 'ACTIVE' AND EXISTS (${RAID_SESSION_AUTH})`)
        .bind(raidId, auth.userId, auth.sessionId, auth.userId),
      c.env.DB.prepare(`SELECT EXISTS (${RAID_SESSION_AUTH}) AS authorized`).bind(auth.sessionId, auth.userId),
      c.env.DB.prepare(`${RAID_SELECT} WHERE r.id = ? AND r.user_id = ?`).bind(raidId, auth.userId),
    ]);
    // Check even already-closed/non-owner/missing targets, but never hide a successful UPDATE
    // because the session expired or was revoked after that mutation's authorization point.
    if (updated.meta.changes === 0 && !(authorization.results as { authorized: number }[])[0]?.authorized) {
      clearSessionCookie(c);
      throw new AppError('AUTHENTICATION_ERROR');
    }
    const row = (selected.results as RaidRow[])[0];
    if (!row) throw new AppError('RAID_SESSION_NOT_FOUND');
    return c.json(toRaidSession(row));
  });
}
