import { AppError } from '../../shared/errors';
import { normalizeNopol } from '../../shared/nopol';
import { parseDueDate } from '../../shared/dates';
import type { Fetcher, VehicleResult, VehicleSource } from './contracts';

export const BPAD_ENDPOINT = 'https://dash.bpad.nttprov.go.id/pajak/webdtd/pendataan/core/php/getnopol.php';
export const BPAD_TIMEOUT_MS = 3000;
export const BPAD_MAX_BYTES = 256 * 1024;

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}
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
    provider_fetched_at: fetchedAt.toISOString(), source: 'LIVE',
  } };
}
async function readBoundedJson(response: Response, registerCancellation: (cancel: () => void) => void): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BPAD_MAX_BYTES)) {
    cancelBody(response.body);
    throw new AppError('UPSTREAM_MALFORMED');
  }
  if (!response.body) throw new AppError('UPSTREAM_MALFORMED');
  const reader = response.body.getReader();
  registerCancellation(() => { void reader.cancel().catch(() => undefined); });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BPAD_MAX_BYTES) throw new AppError('UPSTREAM_MALFORMED');
      chunks.push(value);
    }
  } catch (error) {
    // Never await cancellation: an untrusted stream may never settle cancel().
    void reader.cancel().catch(() => undefined);
    throw error instanceof AppError ? error : new AppError('UPSTREAM_NETWORK');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new AppError('UPSTREAM_MALFORMED'); }
}
export class BpadPublicApiSource implements VehicleSource {
  constructor(private readonly fetcher: Fetcher = fetch, private readonly clock: () => Date = () => new Date()) {}
  async lookup(input: unknown): Promise<VehicleResult> {
    const nopol = normalizeNopol(input);
    const controller = new AbortController();
    let activeReaderCancel: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new AppError('TIMEOUT'));
        controller.abort();
        activeReaderCancel?.();
      }, BPAD_TIMEOUT_MS);
    });
    const operation = async (): Promise<VehicleResult> => {
      let response: Response;
      try { response = await this.fetcher(BPAD_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ nopol }), redirect: 'manual', signal: controller.signal }); }
      catch { throw new AppError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_NETWORK'); }
      if (controller.signal.aborted) { cancelBody(response.body); throw new AppError('TIMEOUT'); }
      if (!response.ok) {
        cancelBody(response.body);
        if (response.status === 504) throw new AppError('TIMEOUT');
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const sanitized = retry !== null && /^\d{1,4}$/.test(retry) && Number(retry) <= 3600 ? String(Number(retry)) : undefined;
          throw new AppError('UPSTREAM_BUSY', sanitized);
        }
        throw new AppError('UPSTREAM_ERROR');
      }
      const payload = await readBoundedJson(response, cancel => { activeReaderCancel = cancel; });
      if (controller.signal.aborted) throw new AppError('TIMEOUT');
      return mapBpadPayload(payload, nopol, this.clock());
    };
    try { return await Promise.race([operation(), deadline]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}
