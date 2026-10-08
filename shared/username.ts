// Shared by the Worker and Node bootstrap scripts. Keep import-free and erasable-syntax only.
export const USERNAME_PATTERN = /^[a-z0-9._-]{1,100}$/;

/**
 * trim() + ASCII lowercase, then `^[a-z0-9._-]{1,100}$`. Input must already be ASCII so Unicode
 * case folding (for example U+212A KELVIN SIGN to "k") cannot create username aliases.
 */
export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 1024) return null;
  const trimmed = input.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(trimmed)) return null;
  const username = trimmed.toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}
