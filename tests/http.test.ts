import { describe, expect, it, vi } from 'vitest';
import { createApp, securityHeaders } from '../worker/index';
import { createSafeLogger } from '../worker/logger';
import { AppError, errorCatalog } from '../shared/errors';

describe('Hono foundation', () => {
  it('health returns JSON with no-store/security and server-generated ID', async () => {
    const app = createApp(() => undefined);
    const response = await app.request('/api/health', { headers: { 'x-request-id': 'attacker-controlled', cookie: 'Synthetic secret' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', phase: 1 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-request-id')).not.toBe('attacker-controlled');
    for (const [key, value] of Object.entries(securityHeaders)) expect(response.headers.get(key)).toBe(value);
  });
  it.each(['/api', '/api/unknown', '/api/health/unknown'])('unknown API %s is JSON not SPA', async path => {
    const response = await createApp(() => undefined).request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND', request_id: response.headers.get('x-request-id') } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('does not leak thrown error or sensitive URL to envelope/logs', async () => {
    const sink = vi.fn<(line: string) => void>();
    const app = createApp(createSafeLogger(sink));
    app.get('/api/failure', () => { throw new Error('Synthetic secret cookie owner_name DH1234ZZ'); });
    const response = await app.request('/api/failure?nopol=DH1234ZZ');
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toMatch(/Synthetic|cookie|owner_name|DH1234ZZ|stack/);
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/Synthetic|cookie|owner_name|DH1234ZZ|stack/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it.each(Object.keys(errorCatalog) as Array<keyof typeof errorCatalog>)('maps safe catalog %s', async code => {
    const app = createApp(() => undefined);
    app.get('/api/failure', () => { throw new AppError(code); });
    const response = await app.request('/api/failure');
    expect(response.status).toBe(errorCatalog[code].status);
    expect(await response.json()).toMatchObject({ error: { code, message: errorCatalog[code].message } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
describe('safe logger runtime allowlist', () => {
  it('projects only event/request_id/code even when extra properties supplied', () => {
    const sink = vi.fn<(line: string) => void>();
    const log = createSafeLogger(sink);
    const entry = { event: 'request_failed' as const, request_id: '00000000-0000-4000-8000-000000000000', code: 'INTERNAL_ERROR' as const, error: new Error('Synthetic secret'), nopol: 'DH1234ZZ', cookie: 'secret', body: 'secret' };
    log(entry);
    expect(JSON.parse(sink.mock.calls[0][0])).toEqual({ event: entry.event, request_id: entry.request_id, code: entry.code });
    log({ event: 'request_failed', request_id: 'bad\nsecret', code: 'INTERNAL_ERROR' });
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
