/** INV-1 — the public data-access layer returns allowlisted public settings only. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getPublicSettings } from '../src/public/index.ts';

const SENTINEL = 'SENTINEL-ADMIN-ONLY-7f3a9c';

describe('getPublicSettings', () => {
  it('returns public keys and never admin-only ones', async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(
        'owner_name',
        'Test Owner',
        now,
      ),
      env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(
        'watermark_text',
        SENTINEL,
        now,
      ),
      env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(
        'contact_to',
        SENTINEL,
        now,
      ),
    ]);
    const result = await getPublicSettings(env.DB);
    expect(result).toEqual({ owner_name: 'Test Owner' });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
