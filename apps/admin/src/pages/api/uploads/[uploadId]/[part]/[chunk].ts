/**
 * PUT /api/uploads/:uploadId/:part/:chunk — one chunk of a video file, as raw
 * bytes (D-60). Chunk 0 is the file's header and is checked completely
 * before it is stored.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { DomainError, VIDEO_CHUNK_BYTES, api, json, storeVideoChunk } from '@cg/core/admin';

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    const declared = request.headers.get('content-length');
    if (declared === null || !/^\d+$/.test(declared)) {
      throw new DomainError('invalid', { reason: 'length_required' });
    }
    if (Number(declared) > VIDEO_CHUNK_BYTES) {
      throw new DomainError('invalid', { reason: 'chunk_too_large' });
    }
    const chunk = String(params['chunk']);
    if (!/^\d{1,3}$/.test(chunk)) throw new DomainError('not_found');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > VIDEO_CHUNK_BYTES) {
      throw new DomainError('invalid', { reason: 'chunk_too_large' });
    }
    return json(
      await storeVideoChunk(
        env.DB,
        env,
        String(params['uploadId']),
        String(params['part']),
        Number(chunk),
        bytes,
      ),
    );
  });
