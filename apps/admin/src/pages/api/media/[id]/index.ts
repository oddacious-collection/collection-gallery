/**
 * PATCH  /api/media/:id {altText} — a photo's alt text (ADM-03).
 * DELETE /api/media/:id — remove a photo (kept 30 days, restorable).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, json, readJson, removeMedia, setMediaAlt } from '@cg/core/admin';

const Body = z.strictObject({ altText: z.string() });

export const PATCH: APIRoute = ({ request, params }) =>
  api(async () => {
    const { altText } = Body.parse(await readJson(request));
    await setMediaAlt(env.DB, String(params['id']), altText, actorOf(request));
    return json({ ok: true });
  });

export const DELETE: APIRoute = ({ request, params }) =>
  api(async () => {
    await removeMedia(env.DB, String(params['id']), actorOf(request));
    return json({ ok: true });
  });
