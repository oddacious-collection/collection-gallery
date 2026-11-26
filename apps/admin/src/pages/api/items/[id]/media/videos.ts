/**
 * POST /api/items/:id/media/videos — start a video upload (D-60). The browser
 * sends what it made on the device (size, duration, sound, the two MP4 file
 * sizes); the answer lists the files to send: the master and the public MP4
 * in chunks, and the poster images like a photo's.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { VideoBegin, api, beginVideoUpload, json, readJson } from '@cg/core/admin';

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const input = VideoBegin.parse(await readJson(request));
    return json(await beginVideoUpload(env.DB, env, String(params['id']), input), 201);
  });
