/** IDs (§4, MED-13) and slugs. */
import { describe, expect, it } from 'vitest';
import { RANDOM_KEY_PATTERN, ULID_PATTERN, randomKey, ulid } from '../src/ids.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, slugify, uniqueSlug } from '../src/slug.ts';

describe('ulid', () => {
  it('is 26 Crockford base32 characters and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(ULID_PATTERN);
  });

  it('sorts by creation time', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
  });

  it('rejects timestamps outside 48 bits', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});

describe('randomKey', () => {
  it('has 128 random bits and never repeats in practice', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => randomKey()));
    expect(keys.size).toBe(1000);
    for (const k of keys) expect(k).toMatch(RANDOM_KEY_PATTERN);
  });
});

describe('slugify', () => {
  it.each([
    ['Seymchan Pallasite, 49 g', 'seymchan-pallasite-49-g'],
    ['  Bézier — Curve!!  ', 'bezier-curve'],
    ['Rocks & Minerals', 'rocks-and-minerals'],
    ['КГБ', 'item'],
    ['', 'item'],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('stays fast on hostile input (no ReDoS)', () => {
    const hostile = `a${'-'.repeat(200_000)}!`;
    const started = Date.now();
    expect(slugify(hostile)).toBe('a');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('caps the length without a trailing hyphen', () => {
    const s = slugify(`${'a'.repeat(79)} b`);
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(s).toMatch(SLUG_PATTERN);
  });
});

describe('uniqueSlug', () => {
  it('appends -2, -3 … until free', async () => {
    const taken = new Set(['meteorite', 'meteorite-2']);
    expect(await uniqueSlug('meteorite', async (c) => taken.has(c))).toBe('meteorite-3');
    expect(await uniqueSlug('fossil', async (c) => taken.has(c))).toBe('fossil');
  });
});
