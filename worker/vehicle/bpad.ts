import { AppError } from '../../shared/errors';
import { normalizeNopol } from '../../shared/nopol';
import { parseDueDate } from '../../shared/dates';
import type { Fetcher, VehicleResult, VehicleSource } from './contracts';
import { retryAfterSeconds, upstreamRequest } from './transport';

export const BPAD_ENDPOINT = 'https://dash.bpad.nttprov.go.id/pajak/webdtd/pendataan/core/php/getnopol.php';
export const BPAD_TIMEOUT_MS = 3000;
export const BPAD_MAX_BYTES = 256 * 1024;

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AppError('UPSTREAM_MALFORMED');
  return value.trim();
}
export function mapBpadPayload(value: unknown, searchedNopol: string, fetchedAt: Date): VehicleResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('UPSTREAM_MALFORMED');
  const record = value as Record<string, unknown>;
  if (record.kode === '0' && record.status === 'failed') {
    // A failed payload containing vehicle facts is contradictory, not verified absence.
    if (['NOPOL', 'NamaPemilik', 'Merk', 'Type', 'Warna', 'SD_NOTICE', 'SD_STNK'].some(key => Object.hasOwn(record, key))) throw new AppError('UPSTREAM_MALFORMED');
    return { outcome: 'NOT_FOUND' };
  }
  if (record.kode !== '1' || record.status !== 'success') throw new AppError('UPSTREAM_MALFORMED');
  let nopol: string;
  try { nopol = normalizeNopol(record.NOPOL); } catch { throw new AppError('UPSTREAM_MALFORMED'); }
  if (nopol !== searchedNopol) throw new AppError('UPSTREAM_MALFORMED');
  return { outcome: 'FOUND', vehicle: {
    nopol, owner_name: boundedString(record.NamaPemilik), brand: boundedString(record.Merk),
    type: boundedString(record.Type), color: boundedString(record.Warna),
    tax_due_date: parseDueDate(record.SD_NOTICE), stnk_due_date: parseDueDate(record.SD_STNK),
    provider_fetched_at: fetchedAt.toISOString(), snapshot_synced_at: null, source: 'LIVE',
  } };
}
/** Live BPAD lookup. Every call goes upstream; no result is cached anywhere. */
export class BpadPublicApiSource implements VehicleSource {
  constructor(private readonly fetcher: Fetcher = fetch, private readonly clock: () => Date = () => new Date()) {}
  async lookup(input: unknown): Promise<VehicleResult> {
    const nopol = normalizeNopol(input);
    return upstreamRequest(this.fetcher, BPAD_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ nopol }) },
      { timeoutMs: BPAD_TIMEOUT_MS, maxBytes: BPAD_MAX_BYTES }, async (response, body) => {
        if (!response.ok) {
          body.discard();
          if (response.status === 504) throw new AppError('TIMEOUT');
          if (response.status === 429) throw new AppError('UPSTREAM_BUSY', retryAfterSeconds(response));
          throw new AppError('UPSTREAM_ERROR');
        }
        return mapBpadPayload(await body.json(), nopol, this.clock());
      });
  }
}
