import { witaToday } from '../../shared/dates';
import { normalizeNopol } from '../../shared/nopol';
import type { VehicleProvider, VehicleResult, VehicleSource } from './contracts';

/** Shift a canonical WITA calendar date, including month/year/leap-day boundaries. */
export function developmentDueDate(now: Date, offsetDays: number): string {
  const [year, month, day] = witaToday(now).split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** Simulated snapshot age for the development Potensi provider (one day before the request). */
export const DEVELOPMENT_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/** Development-only normalized simulation. Never falls through to an external provider for either provider. */
export class DevVehicleSource implements VehicleSource {
  private readonly clock: () => Date;
  constructor(clock: () => Date = () => new Date(), private readonly provider: VehicleProvider = 'BPAD') { this.clock = clock; }
  async lookup(input: unknown): Promise<VehicleResult> {
    const nopol = normalizeNopol(input);
    if (!['DH1823HJ', 'DH7112DP', 'DH5871GD'].includes(nopol)) return { outcome: 'NOT_FOUND' };
    const now = this.clock();
    return { outcome: 'FOUND', vehicle: {
      nopol, owner_name: 'Pemilik Sintetik UAT', brand: 'Merek Sintetik UAT',
      type: 'Tipe Sintetik UAT', color: 'Warna Sintetik UAT',
      tax_due_date: developmentDueDate(now, nopol === 'DH1823HJ' ? 30 : -30),
      stnk_due_date: nopol === 'DH7112DP' ? null : developmentDueDate(now, nopol === 'DH1823HJ' ? 365 : -365),
      provider_fetched_at: now.toISOString(),
      snapshot_synced_at: this.provider === 'POTENSI_NTT' ? new Date(now.getTime() - DEVELOPMENT_SNAPSHOT_AGE_MS).toISOString() : null,
      source: 'LIVE',
    } };
  }
}
