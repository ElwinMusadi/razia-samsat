import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '../shared/errors';
import type { AppEnv } from './types';

export const API_BODY_LIMIT_BYTES = 4 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Media type is case-insensitive; only an optional UTF-8 charset parameter is accepted.
const JSON_CONTENT_TYPE = /^application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")[ \t]*)?$/i;

export const apiBodyLimit = (): MiddlewareHandler<AppEnv> => bodyLimit({
  maxSize: API_BODY_LIMIT_BYTES,
  onError: () => { throw new AppError('PAYLOAD_TOO_LARGE'); },
});

/**
 * P2-05: every state-changing API request (including login) must come from the same origin and carry JSON.
 * Origin must equal the request origin; `Origin: null` is rejected; a missing Origin is accepted only with
 * `Sec-Fetch-Site: same-origin`. A present Sec-Fetch-Site other than same-origin is always rejected. No CORS.
 */
export const csrfProtection = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header('Origin');
  const fetchSite = c.req.header('Sec-Fetch-Site');
  const contentType = c.req.header('Content-Type');
  const originAllowed = origin === undefined ? fetchSite === 'same-origin' : origin === new URL(c.req.url).origin;
  if (!originAllowed || (fetchSite !== undefined && fetchSite !== 'same-origin') || contentType === undefined || !JSON_CONTENT_TYPE.test(contentType.trim())) {
    throw new AppError('CSRF_REJECTED');
  }
  return next();
};
