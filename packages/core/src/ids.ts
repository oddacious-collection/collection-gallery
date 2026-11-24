/**
 * Identifiers.
 *
 * - `ulid()`: row IDs (§4). A ULID's first 48 bits are its creation time, so IDs
 *   are ADMIN data: public responses identify items by slug only (INV-1).
 * - `randomKey()`: storage keys for media (MED-13): 128 random bits, never reused.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, alphabet: string): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

/** A ULID: 10 chars of millisecond timestamp + 16 chars of randomness (Crockford base32). */
export function ulid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 2 ** 48 - 1) {
    throw new RangeError('ulid: timestamp out of range');
  }
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(10)); // 80 bits
  return time + encodeBase32(random, CROCKFORD);
}

export const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** 128-bit random key, lower-case base32 (26 chars), for R2 object names. */
export function randomKey(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(16)), CROCKFORD).toLowerCase();
}

export const RANDOM_KEY_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
