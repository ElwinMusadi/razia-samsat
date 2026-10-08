// Dependency-free PBKDF2-SHA256 password hashing shared by the Worker (workerd) and Node bootstrap scripts.
// Keep this module import-free and erasable-syntax only (no enum, namespace or parameter properties)
// so Node can run it through type stripping.

export const PASSWORD_HASH_SCHEME = 'pbkdf2-sha256';
// Accept the user-approved production count without changing the development configuration.
export const PBKDF2_MIN_ITERATIONS = 10;
// workerd rejects PBKDF2 iteration counts above 100000; Node must not produce hashes workerd cannot verify.
export const PBKDF2_MAX_ITERATIONS = 100000;
export const PASSWORD_MAX_BYTES = 1024;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const STORED_HASH_MAX_LENGTH = 128;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Fixed dummy material keeps unknown-user work comparable to a configured verification.
const DUMMY_SALT = 'cmF6aWEtZHVtbXktc2FsdA';
const encoder = new TextEncoder();

export type ParsedPasswordHash = { iterations: number; salt: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> };
export type PasswordVerification = { ok: boolean; needsRehash: boolean };

export function isValidIterations(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= PBKDF2_MIN_ITERATIONS && value <= PBKDF2_MAX_ITERATIONS;
}

/** Parses a configured iteration count (string var or number). Returns null when invalid. */
export function parseIterationsConfig(value: unknown): number | null {
  if (typeof value === 'number') return isValidIterations(value) ? value : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value)) return null;
  const iterations = Number(value);
  return isValidIterations(iterations) && String(iterations) === value ? iterations : null;
}

export function passwordByteLength(password: string): number {
  return encoder.encode(password).byteLength;
}

/** Non-empty string of at most PASSWORD_MAX_BYTES UTF-8 bytes. No Unicode normalization is applied. */
export function isAcceptablePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0 && password.length <= PASSWORD_MAX_BYTES && passwordByteLength(password) <= PASSWORD_MAX_BYTES;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63] + BASE64URL_ALPHABET[(chunk >> 12) & 63] + BASE64URL_ALPHABET[(chunk >> 6) & 63] + BASE64URL_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63] + BASE64URL_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63] + BASE64URL_ALPHABET[(chunk >> 12) & 63] + BASE64URL_ALPHABET[(chunk >> 6) & 63];
  }
  return output;
}

/** Strict unpadded base64url decoding to an exact byte length; rejects non-canonical encodings. */
export function decodeBase64Url(text: string, expectedBytes: number): Uint8Array<ArrayBuffer> | null {
  if (text.length !== Math.ceil((expectedBytes * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = new Uint8Array(new ArrayBuffer(expectedBytes));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of text) {
    buffer = ((buffer << 6) | BASE64URL_ALPHABET.indexOf(character)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (offset >= expectedBytes) return null;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  if (offset !== expectedBytes || encodeBase64Url(bytes) !== text) return null;
  return bytes;
}

/** Parses `pbkdf2-sha256$<iter>$<salt_b64url>$<hash_b64url>`. Returns null for any malformed value. */
export function parsePasswordHash(stored: unknown): ParsedPasswordHash | null {
  if (typeof stored !== 'string' || stored.length > STORED_HASH_MAX_LENGTH) return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_SCHEME || !/^[1-9][0-9]{0,5}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (!isValidIterations(iterations) || String(iterations) !== parts[1]) return null;
  const salt = decodeBase64Url(parts[2], SALT_BYTES);
  const hash = decodeBase64Url(parts[3], HASH_BYTES);
  return salt && hash ? { iterations, salt, hash } : null;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

// Fixed-length XOR accumulation; portable across Node and workerd without timingSafeEqual.
function equalHashes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== HASH_BYTES || right.length !== HASH_BYTES) return false;
  let difference = 0;
  for (let index = 0; index < HASH_BYTES; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  if (!isValidIterations(iterations)) throw new RangeError('Invalid PBKDF2 iteration count');
  if (!isAcceptablePassword(password)) throw new RangeError('Invalid password length');
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const hash = await derive(password, salt, iterations);
  return `${PASSWORD_HASH_SCHEME}$${iterations}$${encodeBase64Url(salt)}$${encodeBase64Url(hash)}`;
}

/** Performs a PBKDF2 derivation whose result is discarded, for unknown/inactive/malformed accounts. */
export async function dummyVerifyPassword(password: string, iterations: number): Promise<void> {
  if (!isValidIterations(iterations)) throw new RangeError('Invalid PBKDF2 iteration count');
  const salt = decodeBase64Url(DUMMY_SALT, SALT_BYTES);
  if (!salt) throw new Error('Invalid dummy salt');
  await derive(isAcceptablePassword(password) ? password : 'x', salt, iterations);
}

/**
 * Verifies a password against a stored hash. Malformed hashes never verify; when `targetIterations`
 * is supplied, a dummy derivation uses that count. Only hashes below the target need rehash;
 * a higher-count legacy hash is verified as stored and is never downgraded on login.
 */
export async function verifyPassword(password: string, stored: string, targetIterations?: number): Promise<PasswordVerification> {
  if (targetIterations !== undefined && !isValidIterations(targetIterations)) throw new RangeError('Invalid PBKDF2 iteration count');
  const parsed = parsePasswordHash(stored);
  if (!parsed || !isAcceptablePassword(password)) {
    await dummyVerifyPassword(password, targetIterations ?? PBKDF2_MIN_ITERATIONS);
    return { ok: false, needsRehash: false };
  }
  const ok = equalHashes(await derive(password, parsed.salt, parsed.iterations), parsed.hash);
  return { ok, needsRehash: ok && targetIterations !== undefined && parsed.iterations < targetIterations };
}
