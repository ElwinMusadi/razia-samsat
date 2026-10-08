import { AppError } from '../shared/errors';
import { parseIterationsConfig } from '../shared/password';

export const SESSION_TTL_MIN_SECONDS = 1;
// Matches the 400-day Max-Age ceiling accepted by browsers.
export const SESSION_TTL_MAX_SECONDS = 34560000;
export type AuthConfig = { passwordIterations: number; sessionTtlSeconds: number };

function parseTtl(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,7}$/.test(value)) return null;
  const ttl = Number(value);
  return ttl >= SESSION_TTL_MIN_SECONDS && ttl <= SESSION_TTL_MAX_SECONDS ? ttl : null;
}

/** Reads auth vars on every request. Any invalid value fails closed with INTERNAL_ERROR. */
export function readAuthConfig(env: Partial<Env> | undefined): AuthConfig {
  const passwordIterations = parseIterationsConfig(env?.PASSWORD_PBKDF2_ITERATIONS);
  const sessionTtlSeconds = parseTtl(env?.SESSION_TTL_SECONDS);
  if (passwordIterations === null || sessionTtlSeconds === null || !env?.DB) throw new AppError('INTERNAL_ERROR');
  return { passwordIterations, sessionTtlSeconds };
}
