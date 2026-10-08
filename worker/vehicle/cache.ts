import { parseDueDate } from '../../shared/dates';
import { normalizeNopol } from '../../shared/nopol';
import type { SafeLogger } from '../logger';

export const VEHICLE_CACHE_TTL = 300;
export const VEHICLE_CACHE_MAX_BYTES = 4096;
export const VEHICLE_CACHE_TIMEOUT_MS = 500;
export type CachedVehicle = {
  nopol: string; owner_name: string; brand: string; type: string; color: string;
  tax_due_date: string | null; stnk_due_date: string | null; provider_fetched_at: string;
};
export interface VehicleCacheStore {
  get(key: string, type: 'stream'): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}
export type BackgroundTask = (promise: Promise<unknown>) => void;
const FIELDS = ['nopol', 'owner_name', 'brand', 'type', 'color', 'tax_due_date', 'stnk_due_date', 'provider_fetched_at'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// SHA-256 pseudonymization is not encryption: low-entropy plates remain dictionary-enumerable.
export async function vehicleCacheKey(nopol: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`v1:${nopol}`)));
  return `v1:vehicle:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function isFreshVehicle(vehicle: CachedVehicle, now: Date): boolean {
  const timestamp = vehicle.provider_fetched_at;
  if (!ISO_TIMESTAMP.test(timestamp)) return false;
  const fetched = new Date(timestamp);
  const age = now.getTime() - fetched.getTime();
  return Number.isFinite(age) && fetched.toISOString() === timestamp && age >= 0 && age < VEHICLE_CACHE_TTL * 1000;
}
function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function validDate(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDueDate(value) === value);
}
/** Cache schema is exact; invalid dates are a miss, not silently converted to UNKNOWN. */
export function validateCachedVehicle(value: unknown, nopol: string, now: Date): CachedVehicle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(record, key))) return null;
  try { if (record.nopol !== nopol || normalizeNopol(record.nopol) !== nopol) return null; } catch { return null; }
  if (!['owner_name', 'brand', 'type', 'color'].every(key => validString(record[key])) || !validDate(record.tax_due_date) || !validDate(record.stnk_due_date) || typeof record.provider_fetched_at !== 'string') return null;
  const vehicle: CachedVehicle = {
    nopol, owner_name: record.owner_name as string, brand: record.brand as string, type: record.type as string, color: record.color as string,
    tax_due_date: record.tax_due_date, stnk_due_date: record.stnk_due_date, provider_fetched_at: record.provider_fetched_at,
  };
  return isFreshVehicle(vehicle, now) ? vehicle : null;
}
class CacheRejected extends Error {}

/** Deadline covers KV headers and streamed bytes. Late results are cancelled and never decoded. */
export async function readVehicleCache(store: VehicleCacheStore, key: string, nopol: string, clock: () => Date, logger: SafeLogger, requestId: string, background: BackgroundTask): Promise<CachedVehicle | null> {
  let expired = false;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const body = await store.get(key, 'stream');
    if (!body) return null;
    if (expired) { void body.cancel().catch(() => undefined); return null; }
    const reader = body.getReader();
    cancel = () => { void reader.cancel().catch(() => undefined); };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (expired) return null;
        if (done) break;
        size += value.byteLength;
        if (size > VEHICLE_CACHE_MAX_BYTES) throw new CacheRejected();
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new CacheRejected(); }
      const vehicle = validateCachedVehicle(value, nopol, clock());
      if (!vehicle) throw new CacheRejected();
      return vehicle;
    } catch (error) { cancel(); throw error; }
    finally { reader.releaseLock(); }
  })();
  // Track the losing promise too; Promise.race does not cancel KV I/O.
  background(operation.catch(() => undefined));
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; cancel?.(); reject(new Error('Cache deadline')); }, VEHICLE_CACHE_TIMEOUT_MS);
  });
  try { return await Promise.race([operation, deadline]); }
  catch (error) {
    logger({ event: error instanceof CacheRejected ? 'cache_rejected' : 'cache_read_failed', request_id: requestId });
    return null;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Writes never delay the response. Both timeout and eventual rejection are observed without PII. */
export function writeVehicleCache(store: VehicleCacheStore, key: string, vehicle: CachedVehicle, logger: SafeLogger, requestId: string, background: BackgroundTask): void {
  let failed = false;
  const fail = () => { if (!failed) { failed = true; logger({ event: 'cache_write_failed', request_id: requestId }); } };
  const operation = Promise.resolve().then(() => store.put(key, JSON.stringify(vehicle), { expirationTtl: VEHICLE_CACHE_TTL })).catch(fail);
  background(operation);
  background((async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([operation, new Promise<void>(resolve => { timer = setTimeout(() => { fail(); resolve(); }, VEHICLE_CACHE_TIMEOUT_MS); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  })());
}
