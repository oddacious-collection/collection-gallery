/**
 * PUT    /api/media/:id/captions — add or replace a video's captions: the raw
 *        .vtt or .srt file as the body (MED-12, D-65).
 * DELETE /api/media/:id/captions — remove them.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  CAPTIONS_MAX_BYTES,
  DomainError,
  actorOf,
  api,
  json,
  removeVideoCaptions,
  setVideoCaptions,
} from '@cg/core/admin';

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    const declared = request.headers.get('content-length');
    if (declared === null || !/^\d+$/.test(declared)) {
      throw new DomainError('invalid', { reason: 'length_required' });
    }
    if (Number(declared) > CAPTIONS_MAX_BYTES) {
      throw new DomainError('invalid', { reason: 'captions_too_large' });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > CAPTIONS_MAX_BYTES) {
      throw new DomainError('invalid', { reason: 'captions_too_large' });
    }
    return json(await setVideoCaptions(env.DB, env, String(params['id']), bytes, actorOf(request)));
  });

export const DELETE: APIRoute = ({ request, params }) =>
  api(async () => {
    await removeVideoCaptions(env.DB, env, String(params['id']), actorOf(request));
    return json({ ok: true });
  });
