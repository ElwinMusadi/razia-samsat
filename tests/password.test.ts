import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url, dummyVerifyPassword, encodeBase64Url, hashPassword, isAcceptablePassword, parseIterationsConfig,
  parsePasswordHash, PASSWORD_MAX_BYTES, verifyPassword,
} from '../shared/password';
import { normalizeUsername } from '../shared/username';
import { buildCreateLocationSql, buildCreateUserSql, parseFlags } from '../scripts/lib';

const FORMAT = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

describe('PBKDF2 password hashing', () => {
  it('produces the documented format with random salt and verifies only the same password', async () => {
    const first = await hashPassword('Synthetic-Password-1', 1000);
    const second = await hashPassword('Synthetic-Password-1', 1000);
    expect(first).toMatch(FORMAT);
    expect(first).not.toBe(second);
    expect(await verifyPassword('Synthetic-Password-1', first)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('synthetic-password-1', first)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword('Synthetic-Password-1 ', first)).toEqual({ ok: false, needsRehash: false });
  });
  it('reads iterations from the stored hash and flags weaker hashes for rehash', async () => {
    const stored = await hashPassword('Synthetic', 1000);
    expect(await verifyPassword('Synthetic', stored, 2000)).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword('Synthetic', stored, 1000)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('Wrong', stored, 2000)).toEqual({ ok: false, needsRehash: false });
  });
  it('does not normalize Unicode passwords', async () => {
    const composed = 'caf\u00e9';
    const stored = await hashPassword(composed, 1000);
    expect((await verifyPassword(composed, stored)).ok).toBe(true);
    expect((await verifyPassword('cafe\u0301', stored)).ok).toBe(false);
  });
  it('enforces iteration bounds in hash, verify and config parsing', async () => {
    for (const bad of [999, 100001, 1.5, Number.NaN]) await expect(hashPassword('x', bad)).rejects.toThrow(RangeError);
    await expect(verifyPassword('x', 'irrelevant', 100001)).rejects.toThrow(RangeError);
    await expect(dummyVerifyPassword('x', 0)).rejects.toThrow(RangeError);
    expect(parseIterationsConfig('100000')).toBe(100000);
    expect(parseIterationsConfig('1000')).toBe(1000);
    for (const bad of ['999', '100001', '01000', '1e4', ' 1000', '', undefined, null, 'abc']) expect(parseIterationsConfig(bad)).toBeNull();
  });
  it('rejects malformed, non-canonical and out-of-range stored hashes without throwing', async () => {
    const valid = await hashPassword('Synthetic', 1000);
    const [, , salt, hash] = valid.split('$');
    const malformed = [
      '', 'not-a-real-hash', `pbkdf2-sha1$1000$${salt}$${hash}`, `pbkdf2-sha256$999$${salt}$${hash}`,
      `pbkdf2-sha256$100001$${salt}$${hash}`, `pbkdf2-sha256$01000$${salt}$${hash}`, `pbkdf2-sha256$1000$${salt}=$${hash}`,
      `pbkdf2-sha256$1000$${salt}$${hash.slice(0, -1)}`, `pbkdf2-sha256$1000$${salt.slice(0, -1)}B$${hash}`,
      `pbkdf2-sha256$1000$${salt}$${hash}$extra`, `${valid}x`,
    ];
    for (const stored of malformed) {
      expect(parsePasswordHash(stored)).toBeNull();
      expect(await verifyPassword('Synthetic', stored, 1000)).toEqual({ ok: false, needsRehash: false });
    }
  });
  it('limits passwords to 1024 UTF-8 bytes', async () => {
    expect(isAcceptablePassword('a'.repeat(PASSWORD_MAX_BYTES))).toBe(true);
    expect(isAcceptablePassword('a'.repeat(PASSWORD_MAX_BYTES + 1))).toBe(false);
    expect(isAcceptablePassword('\u00e9'.repeat(513))).toBe(false);
    expect(isAcceptablePassword('')).toBe(false);
    await expect(hashPassword('a'.repeat(1025), 1000)).rejects.toThrow(RangeError);
    const stored = await hashPassword('a'.repeat(1024), 1000);
    expect((await verifyPassword('a'.repeat(1025), stored)).ok).toBe(false);
  });
  it('round-trips strict base64url', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(Array.from(decodeBase64Url(encodeBase64Url(bytes), length) ?? [])).toEqual(Array.from(bytes));
    }
    expect(encodeBase64Url(new Uint8Array([251, 255]))).toBe('-_8');
    expect(decodeBase64Url('-_9', 2)).toBeNull();
  });
});

describe('username normalization', () => {
  it('trims, lowercases ASCII and enforces the pattern', () => {
    expect(normalizeUsername('  Synthetic.Officer_1-a ')).toBe('synthetic.officer_1-a');
    for (const bad of ['', '   ', 'a b', 'user@x', '\u212Aelvin', 'a'.repeat(101), 12, null]) expect(normalizeUsername(bad)).toBeNull();
    expect(normalizeUsername('a'.repeat(100))).toBe('a'.repeat(100));
  });
});

describe('bootstrap SQL builders', () => {
  const id = '6b0b7a52-8f4e-4c51-9d5e-2f1a3b4c5d6e';
  it('builds escaped SQL only from validated values', async () => {
    const passwordHash = await hashPassword('Synthetic', 1000);
    expect(buildCreateUserSql({ id, username: 'synthetic.officer', role: 'OFFICER', passwordHash, iterations: 1000 })).toContain(passwordHash);
    expect(buildCreateLocationSql({ id, name: "Pos O'Synthetic" })).toContain("'Pos O''Synthetic'");
    expect(() => buildCreateUserSql({ id: 'x', username: 'synthetic', role: 'OFFICER', passwordHash, iterations: 1000 })).toThrow();
    expect(() => buildCreateUserSql({ id, username: "x');--", role: 'OFFICER', passwordHash, iterations: 1000 })).toThrow();
    expect(() => buildCreateUserSql({ id, username: 'synthetic', role: 'ROOT', passwordHash, iterations: 1000 })).toThrow();
    expect(() => buildCreateUserSql({ id, username: 'synthetic', role: 'OFFICER', passwordHash: 'plain', iterations: 1000 })).toThrow();
    expect(() => buildCreateUserSql({ id, username: 'synthetic', role: 'OFFICER', passwordHash, iterations: 2000 })).toThrow();
    expect(() => buildCreateLocationSql({ id, name: 'Bad\u202Ename' })).toThrow();
    expect(() => buildCreateLocationSql({ id, name: ' padded' })).toThrow();
  });
  it('rejects unknown, repeated and valueless flags (no password flag exists)', () => {
    expect(parseFlags(['--username', 'a', '--role', 'ADMIN'], ['username', 'role']).get('role')).toBe('ADMIN');
    expect(() => parseFlags(['--password', 'secret'], ['username', 'role'])).toThrow();
    expect(() => parseFlags(['--username', 'a', '--username', 'b'], ['username'])).toThrow();
    expect(() => parseFlags(['--username'], ['username'])).toThrow();
  });
});
