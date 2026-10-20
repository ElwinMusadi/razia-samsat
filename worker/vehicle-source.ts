import type { Context } from 'hono';
import { AppError } from '../shared/errors';
import { ADMIN, assertActor, authorization, bindings, exactBody, statement } from './admin';
import { readPage } from './history';
import { errorMessageIncludes } from './http';
import type { SafeLogger } from './logger';
import { clearSessionCookie, currentAuth, requireAuth, requireRole } from './session';
import type { App, AppEnv } from './types';
import { isVehicleProvider, type VehicleProvider } from './vehicle/contracts';
import { readPotensiCredentials } from './vehicle/potensi';
import { parseVehicleSourceSetting } from './vehicle/source';

/** Admin DTO. `updated_by` is null only for the migration seed row. */
export type VehicleSourceResponse = {
  setting: { provider: VehicleProvider; version: number; updated_at: number; updated_by: { id: string; username: string } | null };
  potensi_credentials_configured: boolean;
};
type CurrentRow = { provider: unknown; version: unknown; updated_by: unknown; updated_at: unknown; updated_by_username: unknown };

// The actor's exact session participates in the read, so a revoked admin never sees the setting.
function current(c: Context<AppEnv>): D1PreparedStatement {
  return statement(c, `SELECT v.provider, v.version, v.updated_by, v.updated_at, u.username AS updated_by_username
    FROM vehicle_source_settings v LEFT JOIN users u ON u.id = v.updated_by
    WHERE EXISTS (${ADMIN}) ORDER BY v.version DESC LIMIT 1`, ...bindings(c));
}
function toResponse(c: Context<AppEnv>, result: D1Result): VehicleSourceResponse {
  const row = result.results[0] as CurrentRow | undefined;
  const setting = parseVehicleSourceSetting(row);
  const username = row?.updated_by_username;
  if (setting.updated_by !== null && typeof username !== 'string') throw new AppError('VEHICLE_SOURCE_UNAVAILABLE');
  return {
    setting: { provider: setting.provider, version: setting.version, updated_at: setting.updated_at, updated_by: setting.updated_by === null ? null : { id: setting.updated_by, username: username as string } },
    // Presence of both secrets only; it is not proof that the Access policy or grant is live.
    potensi_credentials_configured: readPotensiCredentials(c.env) !== null,
  };
}

export function registerVehicleSourceRoutes(app: App, logger: SafeLogger): void {
  app.get('/api/admin/vehicle-source', requireAuth(), requireRole('ADMIN'), async c => {
    readPage(c, false);
    const [actor, row] = await c.env.DB.batch([authorization(c), current(c)]);
    assertActor(c, actor);
    return c.json(toResponse(c, row));
  });

  // Compare-and-set on `expected_version`. Two admins racing produce one 200 and one 409, never a silent overwrite.
  app.put('/api/admin/vehicle-source', requireAuth(), requireRole('ADMIN'), async c => {
    const body = await exactBody(c, ['provider', 'expected_version']);
    const provider = body.provider;
    const expected = body.expected_version;
    if (!isVehicleProvider(provider) || typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) throw new AppError('INVALID_INPUT');
    const [actor, before] = await c.env.DB.batch([authorization(c), current(c)]);
    assertActor(c, actor);
    const existing = toResponse(c, before);
    if (existing.setting.version !== expected) throw new AppError('VEHICLE_SOURCE_CONFLICT');
    // Idempotent no-op: the requested provider is already active at this exact version.
    if (existing.setting.provider === provider) return c.json(existing);
    if (provider === 'POTENSI_NTT' && !existing.potensi_credentials_configured) throw new AppError('VEHICLE_SOURCE_CREDENTIALS_MISSING');
    let results: D1Result[];
    try {
      results = await c.env.DB.batch([authorization(c),
        // One INSERT is both the new setting and its audit row; the schema trigger rejects gaps, replays and non-admin actors.
        statement(c, `INSERT INTO vehicle_source_settings(version, provider, updated_by, updated_at)
          SELECT ?, ?, ?, max(unixepoch(), (SELECT max(updated_at) FROM vehicle_source_settings)) WHERE EXISTS (${ADMIN})
          AND EXISTS (SELECT 1 FROM vehicle_source_settings WHERE version = ? AND provider <> ?)
          AND NOT EXISTS (SELECT 1 FROM vehicle_source_settings WHERE version > ?)`,
          expected + 1, provider, currentAuth(c).userId, ...bindings(c), expected, provider, expected),
        current(c)]);
    } catch (error) {
      if (errorMessageIncludes(error, 'Vehicle source version conflict') || errorMessageIncludes(error, 'Vehicle source unchanged')) throw new AppError('VEHICLE_SOURCE_CONFLICT');
      if (errorMessageIncludes(error, 'Active admin required')) { clearSessionCookie(c); throw new AppError('AUTHENTICATION_ERROR'); }
      throw error;
    }
    assertActor(c, results[0]);
    if (results[1].meta.changes !== 1) throw new AppError('VEHICLE_SOURCE_CONFLICT');
    logger({ event: 'vehicle_source_changed', request_id: c.get('requestId') });
    const after = toResponse(c, results[2]);
    if (after.setting.version !== expected + 1 || after.setting.provider !== provider) throw new AppError('INTERNAL_ERROR');
    return c.json(after);
  });
}
