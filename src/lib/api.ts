// Client-only contracts. Do not import the Worker dependency graph.
export type Location = { id: string; name: string };
export type RaidSession = { id: string; location: Location; lane: string; status: 'ACTIVE' | 'CLOSED'; started_at: number; closed_at: number | null };
export type AuthState = { user: { id: string; username: string; role: 'ADMIN' | 'OFFICER' }; session: { expires_at: number }; active_raid_session: RaidSession | null };

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code = 'NETWORK_ERROR', public requestId?: string) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;
function invalid(): never { throw new ApiError('Respons layanan tidak valid. Coba lagi.', 0, 'INVALID_RESPONSE'); }
export function parseLocation(value: unknown): Location {
  if (!object(value) || !id(value.id) || !text(value.name)) return invalid();
  return { id: value.id, name: value.name };
}
export function parseRaid(value: unknown): RaidSession {
  if (!object(value) || !id(value.id) || !text(value.lane) || normalizeLane(value.lane) !== value.lane || !epoch(value.started_at) || (value.status !== 'ACTIVE' && value.status !== 'CLOSED')) return invalid();
  if (value.status === 'ACTIVE' ? value.closed_at !== null : !epoch(value.closed_at) || value.closed_at < value.started_at) return invalid();
  return { id: value.id, location: parseLocation(value.location), lane: value.lane, status: value.status, started_at: value.started_at, closed_at: value.closed_at as number | null };
}
function parseClosed(value: unknown): RaidSession {
  const raid = parseRaid(value);
  if (raid.status !== 'CLOSED') return invalid();
  return raid;
}
function parseStarted(value: unknown): RaidSession {
  const raid = parseRaid(value);
  if (raid.status !== 'ACTIVE') return invalid();
  return raid;
}
function parseActive(value: unknown): RaidSession | null {
  if (value === null) return null;
  const raid = parseRaid(value);
  if (raid.status !== 'ACTIVE') return invalid();
  return raid;
}
export function parseAuth(value: unknown): AuthState {
  if (!object(value) || !object(value.user) || !id(value.user.id) || !text(value.user.username) || (value.user.role !== 'ADMIN' && value.user.role !== 'OFFICER') || !object(value.session) || !epoch(value.session.expires_at)) return invalid();
  return { user: { id: value.user.id, username: value.user.username, role: value.user.role }, session: { expires_at: value.session.expires_at }, active_raid_session: parseActive(value.active_raid_session) };
}
export function parseLocations(value: unknown): Location[] {
  if (!object(value) || !Array.isArray(value.locations)) return invalid();
  return value.locations.map(parseLocation);
}
export function parseActiveResponse(value: unknown): RaidSession | null {
  if (!object(value)) return invalid();
  return parseActive(value.active_raid_session);
}
export function normalizeLane(value: string): string | null {
  const lane = value.trim();
  return [...lane].length >= 1 && [...lane].length <= 100 && !/[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(lane) ? lane : null;
}

// Client-only mirror of shared/nopol.ts (parity locked by tests). The backend stays authoritative;
// punctuation is never stripped silently.
export function normalizeNopol(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const nopol = input.toUpperCase().replace(/\s/g, '');
  return /^[A-Z]{1,2}[0-9]{1,4}[A-Z]{0,3}$/.test(nopol) ? nopol : null;
}

export type VehicleStatus = 'ACTIVE' | 'EXPIRED' | 'UNKNOWN';
export type Vehicle = {
  nopol: string; owner_name: string; brand: string; type: string; color: string;
  tax_due_date: string | null; stnk_due_date: string | null; tax_status: VehicleStatus; stnk_status: VehicleStatus;
};
export type VehicleFound = { outcome: 'FOUND'; vehicle: Vehicle; source: 'LIVE' | 'CACHE'; fetched_at: string; evaluated_on: string; request_id: string };
export type VehicleNotFound = { outcome: 'NOT_FOUND'; request_id: string };
export type VehicleLookupResult = VehicleFound | VehicleNotFound;

const vehicleText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value);
const requestId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(value);
const vehicleStatus = (value: unknown): value is VehicleStatus => value === 'ACTIVE' || value === 'EXPIRED' || value === 'UNKNOWN';
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const dueDate = (value: unknown): value is string | null => value === null || calendarDate(value);
const utcInstant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** Strict allowlist projection. Malformed bodies are INVALID_RESPONSE, never NOT_FOUND. */
export function parseVehicleLookup(value: unknown, requestedNopol: string): VehicleLookupResult {
  if (!object(value) || !requestId(value.request_id)) return invalid();
  const responseId = value.request_id;
  const reject = (): never => { throw new ApiError('Respons layanan tidak valid. Coba lagi.', 0, 'INVALID_RESPONSE', responseId); };
  if (normalizeNopol(requestedNopol) !== requestedNopol) return reject();
  if (value.outcome === 'NOT_FOUND') return { outcome: 'NOT_FOUND', request_id: responseId };
  const vehicle = value.vehicle;
  if (value.outcome !== 'FOUND' || !object(vehicle) || (value.source !== 'LIVE' && value.source !== 'CACHE') || !utcInstant(value.fetched_at) || !calendarDate(value.evaluated_on)) return reject();
  if (vehicle.nopol !== requestedNopol || !vehicleText(vehicle.owner_name) || !vehicleText(vehicle.brand) || !vehicleText(vehicle.type) || !vehicleText(vehicle.color)
    || !dueDate(vehicle.tax_due_date) || !dueDate(vehicle.stnk_due_date) || !vehicleStatus(vehicle.tax_status) || !vehicleStatus(vehicle.stnk_status)) return reject();
  return {
    outcome: 'FOUND',
    vehicle: {
      nopol: requestedNopol, owner_name: vehicle.owner_name, brand: vehicle.brand, type: vehicle.type, color: vehicle.color,
      tax_due_date: vehicle.tax_due_date, stnk_due_date: vehicle.stnk_due_date, tax_status: vehicle.tax_status, stnk_status: vehicle.stnk_status,
    },
    source: value.source, fetched_at: value.fetched_at, evaluated_on: value.evaluated_on, request_id: value.request_id,
  };
}

// History contracts (Phase 5). Snapshots are displayed as recorded; statuses are never recomputed.
export type HistoryOwner = { id: string; username: string };
export type HistoryRaid = RaidSession & { owner: HistoryOwner };
export type HistoryCheck = {
  id: string; nopol: string; outcome: 'FOUND' | 'NOT_FOUND'; tax_status: VehicleStatus | null; stnk_status: VehicleStatus | null;
  source: 'LIVE' | 'CACHE'; checked_at: number;
};
export type HistorySummary = { total_checks: number; found: number; not_found: number; tax_active: number; tax_expired: number; tax_unknown: number };
export type HistoryRaidPage = { raid_sessions: HistoryRaid[]; next_cursor: string | null };
export type HistoryCheckPage = { checks: HistoryCheck[]; next_cursor: string | null };
export type RaidSummary = { raid_session: HistoryRaid; summary: HistorySummary };

// Mirrors the server username normalizer output (shared/username.ts) without importing it.
const historyUsername = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9._-]{1,100}$/.test(value);
/** Opaque server cursor: forwarded verbatim, never constructed or decoded by the client. */
export const isHistoryCursor = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const nextCursor = (value: unknown): value is string | null => value === null || isHistoryCursor(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseHistoryRaid(value: unknown): HistoryRaid {
  const raid = parseRaid(value);
  const owner = (value as Record<string, unknown>).owner;
  if (!object(owner) || !id(owner.id) || !historyUsername(owner.username)) return invalid();
  return { ...raid, owner: { id: owner.id, username: owner.username } };
}
export function parseHistoryCheck(value: unknown): HistoryCheck {
  if (!object(value) || !id(value.id) || typeof value.nopol !== 'string' || normalizeNopol(value.nopol) !== value.nopol || !epoch(value.checked_at)) return invalid();
  const base = { id: value.id, nopol: value.nopol, checked_at: value.checked_at };
  if (value.outcome === 'NOT_FOUND') {
    if (value.tax_status !== null || value.stnk_status !== null || value.source !== 'LIVE') return invalid();
    return { ...base, outcome: 'NOT_FOUND', tax_status: null, stnk_status: null, source: 'LIVE' };
  }
  if (value.outcome !== 'FOUND' || !vehicleStatus(value.tax_status) || !vehicleStatus(value.stnk_status) || (value.source !== 'LIVE' && value.source !== 'CACHE')) return invalid();
  return { ...base, outcome: 'FOUND', tax_status: value.tax_status, stnk_status: value.stnk_status, source: value.source };
}
export function parseHistorySummary(value: unknown): HistorySummary {
  if (!object(value) || !count(value.total_checks) || !count(value.found) || !count(value.not_found) || !count(value.tax_active) || !count(value.tax_expired) || !count(value.tax_unknown)) return invalid();
  if (value.total_checks !== value.found + value.not_found || value.found !== value.tax_active + value.tax_expired + value.tax_unknown) return invalid();
  return { total_checks: value.total_checks, found: value.found, not_found: value.not_found, tax_active: value.tax_active, tax_expired: value.tax_expired, tax_unknown: value.tax_unknown };
}
export function parseHistoryRaidPage(value: unknown): HistoryRaidPage {
  if (!object(value) || !Array.isArray(value.raid_sessions) || !nextCursor(value.next_cursor)) return invalid();
  return { raid_sessions: value.raid_sessions.map(parseHistoryRaid), next_cursor: value.next_cursor };
}
export function parseHistoryCheckPage(value: unknown): HistoryCheckPage {
  if (!object(value) || !Array.isArray(value.checks) || !nextCursor(value.next_cursor)) return invalid();
  return { checks: value.checks.map(parseHistoryCheck), next_cursor: value.next_cursor };
}
/** The summary must describe the requested raid; a different raid is an invalid response. */
export function parseRaidSummary(value: unknown, raidId: string): RaidSummary {
  if (!object(value)) return invalid();
  const raid = parseHistoryRaid(value.raid_session);
  if (raid.id !== raidId) return invalid();
  return { raid_session: raid, summary: parseHistorySummary(value.summary) };
}
function historyQuery(params: { limit?: number; cursor?: string }): string {
  if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 50)) throw new ApiError('Permintaan riwayat tidak valid.', 0, 'INVALID_INPUT');
  if (params.cursor !== undefined && !isHistoryCursor(params.cursor)) throw new ApiError('Permintaan riwayat tidak valid.', 0, 'INVALID_INPUT');
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor !== undefined) search.set('cursor', params.cursor);
  const query = search.toString();
  return query ? `?${query}` : '';
}

// Administration DTOs are projected explicitly; credentials and raw database fields never escape.
export type AdminUser = { id: string; username: string; role: 'ADMIN' | 'OFFICER'; is_active: boolean; created_at: number; updated_at: number; active_session_count: number };
export type AdminSession = { id: string; created_at: number; expires_at: number; is_current: boolean };
export type AdminUserPage = { users: AdminUser[]; next_cursor: string | null };
export type AdminSessionPage = { sessions: AdminSession[]; next_cursor: string | null };
export type AdminMutation = { user: AdminUser; signed_out: boolean };
export function normalizeUsername(input: string): string | null {
  if (input.length > 1024) return null;
  const trimmed = input.trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}
export const isAcceptablePassword = (value: string) => value.length > 0 && new TextEncoder().encode(value).length <= 1024;
export function parseAdminUser(value: unknown, expectedId?: string): AdminUser {
  if (!object(value) || !id(value.id) || (expectedId !== undefined && value.id !== expectedId) || !historyUsername(value.username)
    || (value.role !== 'ADMIN' && value.role !== 'OFFICER') || typeof value.is_active !== 'boolean' || !epoch(value.created_at)
    || !epoch(value.updated_at) || value.updated_at < value.created_at || !count(value.active_session_count)) return invalid();
  return { id: value.id, username: value.username, role: value.role, is_active: value.is_active, created_at: value.created_at, updated_at: value.updated_at, active_session_count: value.active_session_count };
}
export function parseAdminSession(value: unknown): AdminSession {
  if (!object(value) || !id(value.id) || !epoch(value.created_at) || !epoch(value.expires_at) || value.expires_at <= value.created_at || typeof value.is_current !== 'boolean') return invalid();
  return { id: value.id, created_at: value.created_at, expires_at: value.expires_at, is_current: value.is_current };
}
export function parseAdminUsers(value: unknown, limit = 20): AdminUserPage {
  if (!object(value) || !Array.isArray(value.users) || value.users.length > limit || !nextCursor(value.next_cursor)) return invalid();
  return { users: value.users.map(item => parseAdminUser(item)), next_cursor: value.next_cursor };
}
export function parseAdminSessions(value: unknown, limit = 20): AdminSessionPage {
  if (!object(value) || !Array.isArray(value.sessions) || value.sessions.length > limit || !nextCursor(value.next_cursor)) return invalid();
  return { sessions: value.sessions.map(parseAdminSession), next_cursor: value.next_cursor };
}
export function parseAdminMutation(value: unknown, userId: string): AdminMutation {
  if (!object(value) || typeof value.signed_out !== 'boolean') return invalid();
  return { user: parseAdminUser(value.user, userId), signed_out: value.signed_out };
}
const adminPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}`;

export const REQUEST_TIMEOUT_MS = 15000;
async function request<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal, body?: object): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && new TextEncoder().encode(encoded).length > 4096) throw new ApiError('Isian terlalu panjang.', 413, 'PAYLOAD_TOO_LARGE');
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
    if (!response.ok) {
      let value: unknown;
      try { value = await response.json(); } catch { /* Use a safe fallback for non-JSON responses. */ }
      if (object(value) && object(value.error) && text(value.error.message) && text(value.error.code) && text(value.error.request_id)) throw new ApiError(value.error.message, response.status, value.error.code, value.error.request_id);
      throw new ApiError('Layanan bermasalah. Coba lagi.', response.status, 'HTTP_ERROR', response.headers.get('X-Request-ID') ?? undefined);
    }
    if (response.status === 204) return parse(undefined);
    try {
      let value: unknown;
      try { value = await response.json(); } catch { return invalid(); }
      return parse(value);
    } catch (error) {
      // Keep the server request ID for support, even when the body is rejected.
      if (error instanceof ApiError && error.code === 'INVALID_RESPONSE' && !error.requestId) error.requestId = response.headers.get('X-Request-ID') ?? undefined;
      throw error;
    }
  } catch (error) {
    if (timedOut) throw new ApiError('Layanan terlalu lama merespons. Coba lagi.', 0, 'TIMEOUT');
    if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (error instanceof ApiError) throw error;
    throw new ApiError('Tidak dapat terhubung ke layanan. Periksa jaringan dan coba lagi.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const api = {
  // Only allowlisted mutation fields are encoded; role is create-only and the server authorizes every call.
  adminUsers: (page: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<AdminUserPage> =>
    rejecting(() => request(`/api/admin/users${historyQuery({ limit: 20, ...page })}`, value => parseAdminUsers(value, page.limit ?? 20), signal)),
  adminUser: (userId: string, signal?: AbortSignal): Promise<AdminUser> => request(adminPath(userId), value => parseAdminUser(value, userId), signal),
  adminCreate: (username: string, password: string, role: AdminUser['role'], signal?: AbortSignal): Promise<AdminUser> =>
    request('/api/admin/users', value => parseAdminUser(value), signal, { username, password, role }),
  adminActivate: (userId: string, signal?: AbortSignal): Promise<AdminUser> => request(`${adminPath(userId)}/activate`, value => parseAdminUser(value, userId), signal, {}),
  adminDeactivate: (userId: string, signal?: AbortSignal): Promise<AdminUser> => request(`${adminPath(userId)}/deactivate`, value => parseAdminUser(value, userId), signal, {}),
  adminPassword: (userId: string, password: string, signal?: AbortSignal): Promise<AdminMutation> => request(`${adminPath(userId)}/password`, value => parseAdminMutation(value, userId), signal, { password }),
  adminSessions: (userId: string, page: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<AdminSessionPage> =>
    rejecting(() => request(`${adminPath(userId)}/sessions${historyQuery({ limit: 20, ...page })}`, value => parseAdminSessions(value, page.limit ?? 20), signal)),
  adminRevoke: (userId: string, sessionId?: string, signal?: AbortSignal): Promise<AdminMutation> =>
    request(`${adminPath(userId)}/sessions/revoke`, value => parseAdminMutation(value, userId), signal, sessionId === undefined ? {} : { session_id: sessionId }),
  me: (signal?: AbortSignal) => request('/api/auth/me', parseAuth, signal),
  login: (username: string, password: string, signal?: AbortSignal) => request('/api/auth/login', parseAuth, signal, { username, password }),
  logout: (signal?: AbortSignal) => request('/api/auth/logout', () => undefined, signal, {}),
  locations: (signal?: AbortSignal) => request('/api/locations', parseLocations, signal),
  active: (signal?: AbortSignal) => request('/api/raid-sessions/active', parseActiveResponse, signal),
  start: (location_id: string, lane: string, signal?: AbortSignal) => request('/api/raid-sessions', parseStarted, signal, { location_id, lane }),
  close: (raidId: string, signal?: AbortSignal) => request(`/api/raid-sessions/${encodeURIComponent(raidId)}/close`, parseClosed, signal, {}),
  lookup: (nopol: string, signal?: AbortSignal) => request('/api/vehicle-lookups', value => parseVehicleLookup(value, nopol), signal, { nopol }),
  historyRaids: (cursor?: string, signal?: AbortSignal) => rejecting(() => request(`/api/history/raid-sessions${historyQuery({ cursor })}`, parseHistoryRaidPage, signal)),
  raidChecks: (raidId: string, page: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) =>
    rejecting(() => request(`/api/raid-sessions/${encodeURIComponent(raidId)}/checks${historyQuery(page)}`, parseHistoryCheckPage, signal)),
  // The summary endpoint rejects every query parameter, so none is ever appended.
  raidSummary: (raidId: string, signal?: AbortSignal) => request(`/api/raid-sessions/${encodeURIComponent(raidId)}/summary`, value => parseRaidSummary(value, raidId), signal),
};
/** Converts synchronous argument validation failures into rejected promises. */
function rejecting<T>(operation: () => Promise<T>): Promise<T> {
  try { return operation(); } catch (error) { return Promise.reject(error); }
}
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export const errorText = (error: unknown) => error instanceof ApiError ? `${error.message}${error.requestId ? ` (ID permintaan: ${error.requestId})` : ''}` : 'Terjadi kesalahan. Coba lagi.';
export function formatWita(seconds: number): string {
  return `${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(seconds * 1000))} WITA`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
/** Formats a calendar YYYY-MM-DD string directly; no Date/time zone conversion can shift the day. */
export function formatCalendarDate(value: string | null): string {
  if (!calendarDate(value)) return 'Tidak tersedia';
  const [year, month, day] = value.split('-');
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}
/** Formats an ISO UTC instant in Asia/Makassar (WITA), including seconds for freshness. */
export function formatInstantWita(iso: string): string {
  return `${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(iso))} WITA`;
}
