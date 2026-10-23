import { AppError } from '../../shared/errors';
import { parseDueDate } from '../../shared/dates';
import { normalizeNopol } from '../../shared/nopol';
import type { Fetcher, VehicleResult, VehicleSource } from './contracts';
import { retryAfterSeconds, upstreamRequest } from './transport';

/** Fixed server-side endpoint. The host and path are never admin input. */
export const POTENSI_ENDPOINT = 'https://api.uptdpenda-kupang.web.id/api/v1/vehicle';
export const POTENSI_TIMEOUT_MS = 5000;
export const POTENSI_MAX_BYTES = 64 * 1024;
export const POTENSI_CLIENT_ID_BINDING = 'POTENSI_ACCESS_CLIENT_ID';
export const POTENSI_CLIENT_SECRET_BINDING = 'POTENSI_ACCESS_CLIENT_SECRET';
export const POTENSI_API_KEY_BINDING = 'POTENSI_API_KEY';

export type PotensiCredentials = { clientId: string; clientSecret: string; apiKey: string };
export type PotensiEnv = Partial<Pick<Env, typeof POTENSI_CLIENT_ID_BINDING | typeof POTENSI_CLIENT_SECRET_BINDING | typeof POTENSI_API_KEY_BINDING>>;
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;
/** Exact Data Potensi key format: `ptn_<8 alphanumeric prefix>_<43 base64url secret>`. */
const API_KEY = /^ptn_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;
/**
 * Presence check only: both Access secrets must be printable ASCII without whitespace and the API key
 * must match the `ptn_…` format. Presence never proves that the key, Access policy or scopes are valid upstream.
 */
export function readPotensiCredentials(env: PotensiEnv | undefined): PotensiCredentials | null {
  const clientId: unknown = env?.[POTENSI_CLIENT_ID_BINDING];
  const clientSecret: unknown = env?.[POTENSI_CLIENT_SECRET_BINDING];
  const apiKey: unknown = env?.[POTENSI_API_KEY_BINDING];
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || !CREDENTIAL.test(clientId) || !CREDENTIAL.test(clientSecret)) return null;
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) return null;
  return { clientId, clientSecret, apiKey };
}

const SYNCED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('UPSTREAM_MALFORMED');
  return value as Record<string, unknown>;
}
/** A present key is required; an explicit null is a legitimate snapshot gap; any other non-string is malformed. */
function nullableText(record: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(record, key)) throw new AppError('UPSTREAM_MALFORMED');
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 200 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AppError('UPSTREAM_MALFORMED');
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
/** Dates are `YYYY-MM-DD` or null in the upstream contract; an unparseable string degrades to UNKNOWN like BPAD. */
function nullableDate(record: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(record, key)) throw new AppError('UPSTREAM_MALFORMED');
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new AppError('UPSTREAM_MALFORMED');
  return parseDueDate(value);
}
/** Snapshot pull time: upstream writes `new Date().toISOString()`; anything else is a contract break. */
function syncedAt(value: unknown): string {
  if (typeof value !== 'string' || !SYNCED_AT.test(value)) throw new AppError('UPSTREAM_MALFORMED');
  const instant = new Date(value);
  // An impossible calendar value (month 13, day 32) is an invalid Date; toISOString would throw a RangeError.
  if (!Number.isFinite(instant.getTime())) throw new AppError('UPSTREAM_MALFORMED');
  const canonical = instant.toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) throw new AppError('UPSTREAM_MALFORMED');
  return canonical;
}

/** Only the documented absence envelope on HTTP 404 means "not in the snapshot". */
export function isPotensiAbsence(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  return record.status === 'vehicle_not_found' && record.vehicle_status === 'not_found'
    && !!error && typeof error === 'object' && !Array.isArray(error) && (error as Record<string, unknown>).code === 'vehicle_not_found';
}

/** The plate exists upstream but lies outside the regions (UPT) allowed for Razia's API key. */
export function isPotensiRegionNotAllowed(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  return record.status === 'forbidden' && !!error && typeof error === 'object' && !Array.isArray(error)
    && (error as Record<string, unknown>).code === 'region_not_allowed';
}

/**
 * Projects a `vehicle_found` payload onto the normalized contract. Only the needed fields are read;
 * identity numbers, addresses, chassis/engine numbers and amounts never leave this function.
 */
export function mapPotensiPayload(value: unknown, searchedNopol: string, fetchedAt: Date): VehicleResult {
  const record = object(value);
  if (record.status !== 'vehicle_found' || record.vehicle_status !== 'found') throw new AppError('UPSTREAM_MALFORMED');
  let nopol: string;
  try { nopol = normalizeNopol(record.nopol); } catch { throw new AppError('UPSTREAM_MALFORMED'); }
  if (nopol !== searchedNopol) throw new AppError('UPSTREAM_MALFORMED');
  // Each block is required by the granted scopes; a missing block is a scope/contract failure, not null data.
  const vehicle = object(record.vehicle);
  const owner = object(record.owner);
  const registration = object(record.registration);
  const tax = object(record.tax);
  const potensi = object(record.potensi);
  return { outcome: 'FOUND', vehicle: {
    nopol,
    owner_name: nullableText(owner, 'name'),
    brand: nullableText(vehicle, 'brand'),
    type: nullableText(vehicle, 'type'),
    color: nullableText(vehicle, 'color'),
    tax_due_date: nullableDate(tax, 'notice_valid_until'),
    stnk_due_date: nullableDate(registration, 'stnk_valid_until'),
    provider_fetched_at: fetchedAt.toISOString(),
    snapshot_synced_at: syncedAt(potensi.synced_at),
    source: 'LIVE',
  } };
}

/**
 * Potensi NTT snapshot lookup: Data Potensi API key (`Authorization: Bearer`) plus the Cloudflare Access
 * service token while Access still guards the host. Upstream 401/403 is a Razia credential/grant problem
 * (UPSTREAM_FORBIDDEN), never an expired Razia login; the documented 403 `region_not_allowed` envelope is
 * its own outcome (VEHICLE_REGION_NOT_ALLOWED).
 */
export class PotensiSnapshotSource implements VehicleSource {
  constructor(private readonly credentials: PotensiCredentials, private readonly fetcher: Fetcher = fetch, private readonly clock: () => Date = () => new Date()) {}
  async lookup(input: unknown): Promise<VehicleResult> {
    const nopol = normalizeNopol(input);
    const headers = { accept: 'application/json', authorization: `Bearer ${this.credentials.apiKey}`, 'CF-Access-Client-Id': this.credentials.clientId, 'CF-Access-Client-Secret': this.credentials.clientSecret };
    return upstreamRequest(this.fetcher, `${POTENSI_ENDPOINT}/${nopol}`, { method: 'GET', headers }, { timeoutMs: POTENSI_TIMEOUT_MS, maxBytes: POTENSI_MAX_BYTES }, async (response, body) => {
      if (response.status === 404) {
        let payload: unknown;
        try { payload = await body.json(); }
        catch (error) {
          // Access HTML, route 404 or oversize bodies are errors; only the known envelope is absence.
          if (error instanceof AppError && error.code === 'UPSTREAM_MALFORMED') throw new AppError('UPSTREAM_ERROR');
          throw error;
        }
        if (isPotensiAbsence(payload)) return { outcome: 'NOT_FOUND' };
        throw new AppError('UPSTREAM_ERROR');
      }
      if (response.status === 403) {
        let payload: unknown = null;
        try { payload = await body.json(); }
        catch (error) {
          // Access HTML or an oversize body is a plain refusal; transport errors (timeout) propagate.
          if (!(error instanceof AppError && error.code === 'UPSTREAM_MALFORMED')) throw error;
        }
        if (isPotensiRegionNotAllowed(payload)) throw new AppError('VEHICLE_REGION_NOT_ALLOWED');
        throw new AppError('UPSTREAM_FORBIDDEN');
      }
      if (!response.ok) {
        body.discard();
        if (response.status === 401 || response.status === 403) throw new AppError('UPSTREAM_FORBIDDEN');
        if (response.status === 429) throw new AppError('UPSTREAM_BUSY', retryAfterSeconds(response));
        if (response.status === 504) throw new AppError('TIMEOUT');
        throw new AppError('UPSTREAM_ERROR');
      }
      return mapPotensiPayload(await body.json(), nopol, this.clock());
    });
  }
}
