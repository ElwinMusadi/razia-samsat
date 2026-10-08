import { Hono } from 'hono';
import { errorCatalog, safeError } from '../shared/errors';
import { registerAuthRoutes } from './auth';
import { registerAdminRoutes } from './admin';
import { registerHistoryRoutes } from './history';
import { createSafeLogger, type SafeLogger } from './logger';
import { registerRaidRoutes } from './raids';
import { registerLookupRoutes, type LookupDependencies } from './lookups';
import { apiBodyLimit, csrfProtection } from './security';
import type { AppEnv } from './types';

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
} as const;
export function createApp(logger: SafeLogger = createSafeLogger(), lookupDependencies: LookupDependencies = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('X-Request-ID', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    for (const [key, value] of Object.entries(securityHeaders)) c.header(key, value);
    await next();
  });
  app.onError((error, c) => {
    const safe = safeError(error);
    logger({ event: 'request_failed', request_id: c.get('requestId'), code: safe.code });
    if (safe.retryAfter && /^\d{1,4}$/.test(safe.retryAfter) && Number(safe.retryAfter) <= 3600) c.header('Retry-After', safe.retryAfter);
    return c.json({ error: { code: safe.code, message: errorCatalog[safe.code].message, request_id: c.get('requestId') } }, errorCatalog[safe.code].status);
  });
  // CSRF runs before any body is read; the body limit then bounds every API payload.
  app.use('/api/*', csrfProtection(), apiBodyLimit());
  app.get('/api/health', c => c.json({ status: 'ok', phase: 1 }));
  registerAuthRoutes(app, logger);
  registerAdminRoutes(app);
  registerRaidRoutes(app);
  registerHistoryRoutes(app);
  registerLookupRoutes(app, logger, lookupDependencies);
  app.notFound(c => c.json({ error: { code: 'ROUTE_NOT_FOUND', message: errorCatalog.ROUTE_NOT_FOUND.message, request_id: c.get('requestId') } }, 404));
  return app;
}
const app = createApp();
export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    return path === '/api' || path.startsWith('/api/') ? app.fetch(request, env, ctx) : env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
