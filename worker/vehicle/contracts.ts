export interface NormalizedVehicle {
  nopol: string;
  owner_name: string;
  brand: string;
  type: string;
  color: string;
  tax_due_date: string | null;
  stnk_due_date: string | null;
  provider_fetched_at: string;
  source: 'LIVE' | 'CACHE';
}
export type VehicleResult = { outcome: 'FOUND'; vehicle: NormalizedVehicle } | { outcome: 'NOT_FOUND' };
export interface VehicleSource { lookup(nopol: unknown): Promise<VehicleResult> }
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
