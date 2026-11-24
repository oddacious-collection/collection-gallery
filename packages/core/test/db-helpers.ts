/** Test helpers that insert rows directly (bypassing admin flows not built yet). */
import { env } from 'cloudflare:workers';
import { ulid, randomKey } from '../src/ids.ts';

export const ACTOR = 'owner@example.test';

export async function insertCategory(name: string, slug: string, parentId: string | null = null) {
  const id = ulid();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO categories (id, parent_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, parentId, name, slug, now, now),
    env.DB.prepare(
      'INSERT INTO category_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)',
    ).bind(id, id),
  ]);
  return id;
}

export async function insertMedia(itemId: string, position = 0) {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO media (id, item_id, position, is_cover, kind, original_key, width, height, created_at)
     VALUES (?, ?, ?, ?, 'image', ?, 800, 600, ?)`,
  )
    .bind(id, itemId, position, position === 0 ? 1 : 0, randomKey(), new Date().toISOString())
    .run();
  return id;
}

export async function count(table: string, where = '1', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
