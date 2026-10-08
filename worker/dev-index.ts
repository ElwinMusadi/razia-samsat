import { errorCatalog } from '../shared/errors';
import { createApp, securityHeaders } from './index';
import { DevVehicleSource } from './vehicle/development';

// APP_ENV is an additional development-entry marker, not a duplicate binding schema.
export type DevelopmentEnv = Env & { APP_ENV?: string };
export function isLocalDevelopment(request: Request, env: DevelopmentEnv): boolean {
  const url = new URL(request.url);
  return env.APP_ENV === 'development' && ['http:', 'https:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function createDevelopmentHandler(clock: () => Date = () => new Date()): ExportedHandler<DevelopmentEnv> {
  const app = createApp(undefined, { source: new DevVehicleSource(clock), clock });
  return {
    fetch(request, env, ctx) {
      // URL origin plus the config marker are defense in depth, not proof of a local listener.
      // The launcher also binds Wrangler to loopback and forbids remote resource configuration.
      if (!isLocalDevelopment(request, env)) {
        const requestId = crypto.randomUUID();
        return Response.json({ error: { code: 'ROUTE_NOT_FOUND', message: errorCatalog.ROUTE_NOT_FOUND.message, request_id: requestId } }, {
          status: 503, headers: { ...securityHeaders, 'Cache-Control': 'no-store', 'X-Request-ID': requestId },
        });
      }
      const path = new URL(request.url).pathname;
      return path === '/api' || path.startsWith('/api/') ? app.fetch(request, env, ctx) : env.ASSETS.fetch(request);
    },
  };
}
export default createDevelopmentHandler();
