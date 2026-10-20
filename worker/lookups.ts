import type { Context } from 'hono';
import { dueStatus, parseDueDate, witaToday } from '../shared/dates';
import { AppError } from '../shared/errors';
import { normalizeNopol } from '../shared/nopol';
import { readJsonObject } from './http';
import type { SafeLogger } from './logger';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App, AppEnv } from './types';
import type { Fetcher, NormalizedVehicle, VehicleProvider } from './vehicle/contracts';
import { parseVehicleProvider, resolveVehicleSource, type VehicleSourceOverrides } from './vehicle/source';

/**
 * Test/development seams. `sources` overrides the adapter per provider; the global setting in D1
 * still decides which provider a lookup uses. There is no cache seam: lookups never cache.
 */
export type LookupDependencies = { sources?: VehicleSourceOverrides; clock?: () => Date; fetcher?: Fetcher };

type RaidSnapshot = { raidId: string; provider: VehicleProvider };
/**
 * Auth, raid and the global provider share one D1 statement snapshot at the start of a lookup.
 * The final revalidation after upstream work rechecks auth and the captured raid only: an in-flight
 * request finishes with the provider it started with, and the new setting applies to the next lookup.
 */
async function captureRaid(c: Context<AppEnv>, capturedId?: string): Promise<RaidSnapshot> {
  const auth = currentAuth(c);
  const row = await c.env.DB.prepare(`SELECT r.id AS raid_id,
    (SELECT provider FROM vehicle_source_settings ORDER BY version DESC LIMIT 1) AS provider
    FROM user_sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN raid_sessions r ON r.user_id = s.user_id AND r.status = 'ACTIVE' AND (? IS NULL OR r.id = ?)
    WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()
    AND u.is_active = 1 AND u.role IN ('ADMIN', 'OFFICER')`)
    .bind(capturedId ?? null, capturedId ?? null, auth.sessionId, auth.userId).first<{ raid_id: string | null; provider: unknown }>();
  if (!row) { clearSessionCookie(c); throw new AppError('AUTHENTICATION_ERROR'); }
  if (!row.raid_id) throw new AppError('RAID_SESSION_REQUIRED');
  return { raidId: row.raid_id, provider: parseVehicleProvider(row.provider) };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoInstant = (value: unknown): value is string => typeof value === 'string' && ISO_TIMESTAMP.test(value) && new Date(value).toISOString() === value;
const nullableText = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value));
const validDate = (value: unknown): value is string | null => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDueDate(value) === value);

/** Project even injected sources; unexpected properties can never reach the response or history. */
function sanitizeResult(value: unknown, nopol: string, provider: VehicleProvider): NormalizedVehicle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('UPSTREAM_MALFORMED');
  const result = value as Record<string, unknown>;
  if (result.outcome === 'NOT_FOUND') return null;
  if (result.outcome !== 'FOUND' || !result.vehicle || typeof result.vehicle !== 'object' || Array.isArray(result.vehicle)) throw new AppError('UPSTREAM_MALFORMED');
  const vehicle = result.vehicle as Record<string, unknown>;
  let normalized: string;
  try { normalized = normalizeNopol(vehicle.nopol); } catch { throw new AppError('UPSTREAM_MALFORMED'); }
  if (vehicle.source !== 'LIVE' || vehicle.nopol !== nopol || normalized !== nopol) throw new AppError('UPSTREAM_MALFORMED');
  if (!nullableText(vehicle.owner_name) || !nullableText(vehicle.brand) || !nullableText(vehicle.type) || !nullableText(vehicle.color)) throw new AppError('UPSTREAM_MALFORMED');
  if (!validDate(vehicle.tax_due_date) || !validDate(vehicle.stnk_due_date) || !isoInstant(vehicle.provider_fetched_at)) throw new AppError('UPSTREAM_MALFORMED');
  // BPAD is live data without a snapshot time; Potensi must state when its BPAD snapshot was pulled.
  const synced = vehicle.snapshot_synced_at;
  if (provider === 'BPAD' ? synced !== null : !isoInstant(synced)) throw new AppError('UPSTREAM_MALFORMED');
  return {
    nopol, owner_name: vehicle.owner_name, brand: vehicle.brand, type: vehicle.type, color: vehicle.color,
    tax_due_date: vehicle.tax_due_date, stnk_due_date: vehicle.stnk_due_date,
    provider_fetched_at: vehicle.provider_fetched_at, snapshot_synced_at: synced as string | null, source: 'LIVE',
  };
}

export function registerLookupRoutes(app: App, logger: SafeLogger, dependencies: LookupDependencies = {}): void {
  const clock = dependencies.clock ?? (() => new Date());
  const fetcher: Fetcher = dependencies.fetcher ?? ((input, init) => fetch(input, init));
  app.post('/api/vehicle-lookups', requireAuth(), requireRole('ADMIN', 'OFFICER'), async c => {
    const body = await readJsonObject(c);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'nopol')) throw new AppError('INVALID_INPUT');
    const nopol = normalizeNopol(body.nopol);
    const { raidId, provider } = await captureRaid(c);
    // Resolve the adapter before any upstream work; a selected provider without credentials fails closed.
    const source = resolveVehicleSource(provider, c.env, dependencies.sources, fetcher, clock);
    const requestId = c.get('requestId');
    // Every valid lookup calls upstream, including a repeated plate: there is no KV, Cache API or memory cache.
    const vehicle = sanitizeResult(await source.lookup(nopol), nopol, provider);
    await captureRaid(c, raidId);
    const now = clock();
    const taxStatus = vehicle ? dueStatus(vehicle.tax_due_date, now) : null;
    const stnkStatus = vehicle ? dueStatus(vehicle.stnk_due_date, now) : null;
    const userId = currentAuth(c).userId;
    const checkedAt = Math.floor(now.getTime() / 1000);
    const outcome = vehicle ? 'FOUND' : 'NOT_FOUND';
    // D5-01/D5-02: the first successful persistence per raid+plate wins; a repeated lookup still calls
    // upstream but never adds or overwrites that snapshot. Only the business-key conflict is a no-op.
    c.executionCtx.waitUntil((async () => {
      try {
        await c.env.DB.prepare(`INSERT INTO check_logs
          (id, raid_session_id, user_id, idempotency_key, nopol, outcome, tax_status, stnk_status, source, checked_at, vehicle_brand, vehicle_type, vehicle_color, provider)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(raid_session_id, nopol) DO NOTHING`)
          .bind(crypto.randomUUID(), raidId, userId, requestId, nopol, outcome, taxStatus, stnkStatus, 'LIVE', checkedAt, vehicle?.brand ?? null, vehicle?.type ?? null, vehicle?.color ?? null, provider).run();
      } catch {
        logger({ event: 'history_write_failed', request_id: requestId });
      }
    })());
    if (!vehicle) return c.json({ outcome: 'NOT_FOUND', provider, request_id: requestId });
    return c.json({ outcome: 'FOUND', vehicle: {
      nopol: vehicle.nopol, owner_name: vehicle.owner_name, brand: vehicle.brand, type: vehicle.type, color: vehicle.color,
      tax_due_date: vehicle.tax_due_date, stnk_due_date: vehicle.stnk_due_date,
      tax_status: taxStatus, stnk_status: stnkStatus,
    }, source: 'LIVE', provider, fetched_at: vehicle.provider_fetched_at, snapshot_synced_at: vehicle.snapshot_synced_at, evaluated_on: witaToday(now), request_id: requestId });
  });
}
