import type { Context } from 'hono';
import { AppError } from '../shared/errors';
import type { AppEnv } from './types';

/** Parses a JSON object body. Malformed UTF-8/JSON or a non-object payload is INVALID_INPUT. */
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await c.req.arrayBuffer());
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_INPUT');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_INPUT');
  return value as Record<string, unknown>;
}

/** D1 surfaces trigger/constraint failures only as message text; match known substrings only. */
export function errorMessageIncludes(error: unknown, fragment: string): boolean {
  return error instanceof Error && error.message.includes(fragment);
}
