import { AppError } from './errors';
export function normalizeNopol(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64) throw new AppError('INVALID_INPUT');
  const nopol = input.toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z]{1,2}[0-9]{1,4}[A-Z]{0,3}$/.test(nopol)) throw new AppError('INVALID_INPUT');
  return nopol;
}
