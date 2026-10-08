export type DueStatus = 'ACTIVE' | 'EXPIRED' | 'UNKNOWN';
export function parseDueDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (local) [, day, month, year] = local.map(Number);
  else return null;
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function witaToday(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid clock');
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function dueStatus(due: unknown, now: Date = new Date()): DueStatus {
  const date = parseDueDate(due);
  return date === null ? 'UNKNOWN' : witaToday(now) >= date ? 'EXPIRED' : 'ACTIVE';
}
