import { normalizeNopol } from '../../shared/nopol';
import type { VehicleResult, VehicleSource } from './contracts';
export class MockVehicleSource implements VehicleSource {
  async lookup(input: unknown): Promise<VehicleResult> {
    const nopol = normalizeNopol(input);
    if (nopol !== 'DH1234ZZ') return { outcome: 'NOT_FOUND' };
    return { outcome: 'FOUND', vehicle: { nopol, owner_name: 'Synthetic Owner', brand: 'Synthetic Brand', type: 'Synthetic Type', color: 'Synthetic Color', tax_due_date: '2026-10-07', stnk_due_date: '2027-10-07', provider_fetched_at: '2026-10-07T00:00:00.000Z', source: 'LIVE' } };
  }
}
