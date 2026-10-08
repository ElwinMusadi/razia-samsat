import type { Context } from 'hono';
import { dueStatus, witaToday } from '../shared/dates';
import { AppError } from '../shared/errors';
import { normalizeNopol } from '../shared/nopol';
import { readJsonObject } from './http';
import type { SafeLogger } from './logger';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App, AppEnv } from './types';
import { BpadPublicApiSource } from './vehicle/bpad';
import { isFreshVehicle, readVehicleCache, validateCachedVehicle, vehicleCacheKey, writeVehicleCache, type CachedVehicle, type VehicleCacheStore } from './vehicle/cache';
import type { VehicleSource } from './vehicle/contracts';

export type LookupDependencies = { source?: VehicleSource; clock?: () => Date; cache?: VehicleCacheStore };

/** Auth and raid share one D1 statement snapshot, before and after asynchronous lookup work. */
async function captureRaid(c: Context<AppEnv>, capturedId?: string): Promise<string> {
  const auth = currentAuth(c);
  const row = await c.env.DB.prepare(`SELECT r.id AS raid_id FROM user_sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN raid_sessions r ON r.user_id = s.user_id AND r.status = 'ACTIVE' AND (? IS NULL OR r.id = ?)
    WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > unixepoch()
    AND u.is_active = 1 AND u.role IN ('ADMIN', 'OFFICER')`)
    .bind(capturedId ?? null, capturedId ?? null, auth.sessionId, auth.userId).first<{ raid_id: string | null }>();
  if (!row) { clearSessionCookie(c); throw new AppError('AUTHENTICATION_ERROR'); }
  if (!row.raid_id) throw new AppError('RAID_SESSION_REQUIRED');
  return row.raid_id;
}

/** Project even injected sources; unexpected properties can never reach cache or response. */
function sanitizeLive(value: unknown, nopol: string, now: Date): CachedVehicle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('UPSTREAM_MALFORMED');
  const result = value as Record<string, unknown>;
  if (result.outcome === 'NOT_FOUND') return null;
  if (result.outcome !== 'FOUND' || !result.vehicle || typeof result.vehicle !== 'object' || Array.isArray(result.vehicle)) throw new AppError('UPSTREAM_MALFORMED');
  const vehicle = result.vehicle as Record<string, unknown>;
  if (vehicle.source !== 'LIVE') throw new AppError('UPSTREAM_MALFORMED');
  const projected = {
    nopol: vehicle.nopol, owner_name: vehicle.owner_name, brand: vehicle.brand, type: vehicle.type, color: vehicle.color,
    tax_due_date: vehicle.tax_due_date, stnk_due_date: vehicle.stnk_due_date, provider_fetched_at: vehicle.provider_fetched_at,
  };
  const normalized = validateCachedVehicle(projected, nopol, now);
  if (!normalized) throw new AppError('UPSTREAM_MALFORMED');
  return normalized;
}

export function registerLookupRoutes(app: App, logger: SafeLogger, dependencies: LookupDependencies = {}): void {
  const clock = dependencies.clock ?? (() => new Date());
  const source = dependencies.source ?? new BpadPublicApiSource((input, init) => fetch(input, init), clock);
  app.post('/api/vehicle-lookups', requireAuth(), requireRole('ADMIN', 'OFFICER'), async c => {
    const body = await readJsonObject(c);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'nopol')) throw new AppError('INVALID_INPUT');
    const nopol = normalizeNopol(body.nopol);
    const raidId = await captureRaid(c);
    const key = await vehicleCacheKey(nopol);
    const store = dependencies.cache ?? c.env.VEHICLE_CACHE;
    const background = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
    const requestId = c.get('requestId');
    let vehicle = await readVehicleCache(store, key, nopol, clock, logger, requestId, background);
    let provenance: 'LIVE' | 'CACHE' = vehicle ? 'CACHE' : 'LIVE';
    if (!vehicle) {
      await captureRaid(c, raidId);
      vehicle = sanitizeLive(await source.lookup(nopol), nopol, clock());
    }
    await captureRaid(c, raidId);
    let now = clock();
    // Re-evaluate freshness after D1 too. A cache entry crossing TTL falls back to the provider.
    if (vehicle && provenance === 'CACHE' && !isFreshVehicle(vehicle, now)) {
      logger({ event: 'cache_rejected', request_id: requestId });
      vehicle = sanitizeLive(await source.lookup(nopol), nopol, clock());
      provenance = 'LIVE';
      await captureRaid(c, raidId);
      now = clock();
    }
    if (vehicle && !isFreshVehicle(vehicle, now)) throw new AppError('UPSTREAM_MALFORMED');
    const taxStatus = vehicle ? dueStatus(vehicle.tax_due_date, now) : null;
    const stnkStatus = vehicle ? dueStatus(vehicle.stnk_due_date, now) : null;
    const userId = currentAuth(c).userId;
    const checkedAt = Math.floor(now.getTime() / 1000);
    const outcome = vehicle ? 'FOUND' : 'NOT_FOUND';
    // The first successful persistence wins. Only the business-key conflict is a no-op.
    // This immutable authorized snapshot does not recheck activity after the final guard.
    background((async () => {
      try {
        await c.env.DB.prepare(`INSERT INTO check_logs
          (id, raid_session_id, user_id, idempotency_key, nopol, outcome, tax_status, stnk_status, source, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(raid_session_id, nopol) DO NOTHING`)
          .bind(crypto.randomUUID(), raidId, userId, requestId, nopol, outcome, taxStatus, stnkStatus, provenance, checkedAt).run();
      } catch {
        logger({ event: 'history_write_failed', request_id: requestId });
      }
    })());
    if (!vehicle) return c.json({ outcome: 'NOT_FOUND', request_id: requestId });
    if (provenance === 'LIVE') writeVehicleCache(store, key, vehicle, logger, requestId, background);
    return c.json({ outcome: 'FOUND', vehicle: {
      nopol: vehicle.nopol, owner_name: vehicle.owner_name, brand: vehicle.brand, type: vehicle.type, color: vehicle.color,
      tax_due_date: vehicle.tax_due_date, stnk_due_date: vehicle.stnk_due_date,
      tax_status: taxStatus, stnk_status: stnkStatus,
    }, source: provenance, fetched_at: vehicle.provider_fetched_at, evaluated_on: witaToday(now), request_id: requestId });
  });
}
