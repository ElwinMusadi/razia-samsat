import { errorCatalog, type ErrorCode } from '../shared/errors';
// Allowlisted events only. Never add username, password, token, cookie, IP or request body fields.
const events = ['request_failed', 'request_completed', 'auth_login_succeeded', 'auth_logout', 'cache_read_failed', 'cache_rejected', 'cache_write_failed', 'history_write_failed'] as const;
export type SafeLogEvent = { event: typeof events[number]; request_id: string; code?: ErrorCode };
export type SafeLogger = (entry: SafeLogEvent) => void;
export function createSafeLogger(sink: (line: string) => void = line => console.log(line)): SafeLogger {
  return (entry: SafeLogEvent): void => {
    if (!events.includes(entry.event) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.request_id)) return;
    const code = entry.code !== undefined && Object.hasOwn(errorCatalog, entry.code) ? entry.code : undefined;
    sink(JSON.stringify({ event: entry.event, request_id: entry.request_id, ...(code ? { code } : {}) }));
  };
}
