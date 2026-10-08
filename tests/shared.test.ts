import { describe, it, expect } from 'vitest';
import { normalizeNopol } from '../shared/nopol';
import { parseDueDate, witaToday, dueStatus } from '../shared/dates';

describe('NOPOL normalization', () => {
  it.each([[' dh 1234 zz ', 'DH1234ZZ'], ['a\t1\n', 'A1'], ['AB9999XYZ', 'AB9999XYZ']])('normalizes %s', (input, expected) => expect(normalizeNopol(input)).toBe(expected));
  it.each([null, undefined, 1234, {}, [], '', 'DH-1234-ZZ', 'DH.1234ZZ', 'ＤＨ１２３４', 'ABC1234', 'DH12345ZZ', 'DH1234ABCD', '123DH', 'DH', 'DH1/ZZ'])('rejects %j without coercion', input => expect(() => normalizeNopol(input)).toThrow('Masukan tidak valid.'));
});
describe('strict due dates and WITA boundaries', () => {
  it.each([['07/10/2026', '2026-10-07'], ['2026-10-07', '2026-10-07'], ['29/02/2024', '2024-02-29'], ['2000-02-29', '2000-02-29'], ['0001-01-01', '0001-01-01']])('parses %s', (value, expected) => expect(parseDueDate(value)).toBe(expected));
  it.each([undefined, null, 20261007, {}, '', '2026-2-01', '7/10/2026', '2026-10-07T00:00:00Z', ' 2026-10-07', '1900-02-29', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '10-07-2026'])('rejects %j', value => expect(parseDueDate(value)).toBeNull());
  it('changes WITA day exactly at UTC 16:00', () => {
    expect(witaToday(new Date('2026-10-06T15:59:59.999Z'))).toBe('2026-10-06');
    expect(witaToday(new Date('2026-10-06T16:00:00.000Z'))).toBe('2026-10-07');
    expect(dueStatus('07/10/2026', new Date('2026-10-06T15:59:59.999Z'))).toBe('ACTIVE');
    expect(dueStatus('2026-10-07', new Date('2026-10-06T16:00:00Z'))).toBe('EXPIRED');
    expect(dueStatus('2026-10-06', new Date('2026-10-06T16:00:00Z'))).toBe('EXPIRED');
    expect(dueStatus(null)).toBe('UNKNOWN');
    expect(dueStatus('2026-02-29')).toBe('UNKNOWN');
    expect(() => witaToday(new Date(NaN))).toThrow('Invalid clock');
  });
});
