import { AppError } from '../../shared/errors';
import { BpadPublicApiSource } from './bpad';
import { isVehicleProvider, type Fetcher, type VehicleProvider, type VehicleSource } from './contracts';
import { PotensiSnapshotSource, readPotensiCredentials, type PotensiEnv } from './potensi';

/** Current global setting row (highest version). `updated_by` is null only for the migration seed. */
export type VehicleSourceSetting = { provider: VehicleProvider; version: number; updated_by: string | null; updated_at: number };

/** Fail closed: a missing or malformed setting is VEHICLE_SOURCE_UNAVAILABLE, never a silent BPAD reset. */
export function parseVehicleSourceSetting(row: unknown): VehicleSourceSetting {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new AppError('VEHICLE_SOURCE_UNAVAILABLE');
  const record = row as Record<string, unknown>;
  if (!isVehicleProvider(record.provider) || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1
    || (record.updated_by !== null && typeof record.updated_by !== 'string') || typeof record.updated_at !== 'number' || !Number.isSafeInteger(record.updated_at) || record.updated_at < 0) throw new AppError('VEHICLE_SOURCE_UNAVAILABLE');
  return { provider: record.provider, version: record.version, updated_by: record.updated_by, updated_at: record.updated_at };
}
export function parseVehicleProvider(value: unknown): VehicleProvider {
  if (!isVehicleProvider(value)) throw new AppError('VEHICLE_SOURCE_UNAVAILABLE');
  return value;
}

export type VehicleSourceOverrides = Partial<Record<VehicleProvider, VehicleSource>>;
/**
 * Builds the adapter for the provider captured at the start of a lookup. Potensi requires both
 * runtime secrets; without them the lookup fails closed instead of falling back to BPAD.
 */
export function resolveVehicleSource(provider: VehicleProvider, env: PotensiEnv | undefined, overrides: VehicleSourceOverrides | undefined, fetcher: Fetcher, clock: () => Date): VehicleSource {
  const override = overrides?.[provider];
  if (override) return override;
  if (provider === 'BPAD') return new BpadPublicApiSource(fetcher, clock);
  const credentials = readPotensiCredentials(env);
  if (!credentials) throw new AppError('VEHICLE_SOURCE_UNAVAILABLE');
  return new PotensiSnapshotSource(credentials, fetcher, clock);
}
