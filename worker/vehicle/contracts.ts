export const VEHICLE_PROVIDERS = ['BPAD', 'POTENSI_NTT'] as const;
export type VehicleProvider = typeof VEHICLE_PROVIDERS[number];
export const isVehicleProvider = (value: unknown): value is VehicleProvider => VEHICLE_PROVIDERS.includes(value as VehicleProvider);

/**
 * Provider-normalized vehicle. Identity fields are nullable because the Potensi snapshot may carry
 * explicit nulls; a missing key or wrong type stays malformed in the adapter. `source` is always
 * LIVE: every lookup calls upstream. `snapshot_synced_at` is the snapshot pull time (POTENSI only).
 */
export interface NormalizedVehicle {
  nopol: string;
  owner_name: string | null;
  brand: string | null;
  type: string | null;
  color: string | null;
  tax_due_date: string | null;
  stnk_due_date: string | null;
  provider_fetched_at: string;
  snapshot_synced_at: string | null;
  source: 'LIVE';
}
export type VehicleResult = { outcome: 'FOUND'; vehicle: NormalizedVehicle } | { outcome: 'NOT_FOUND' };
export interface VehicleSource { lookup(nopol: unknown): Promise<VehicleResult> }
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
