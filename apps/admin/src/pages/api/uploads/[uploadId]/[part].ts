/**
 * PUT /api/uploads/:uploadId/:part — one processed file of a photo upload,
 * as raw bytes (D-46). The server verifies it before storing it (MED-03).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { DomainError, MAX_UPLOAD_PART_BYTES, api, json, storeUploadPart } from '@cg/core/admin';

export const PUT: APIRoute = ({ request, params }) =>
  api(async () => {
    // A declared length is required, and checked before the body is read.
    const declared = request.headers.get('content-length');
    if (declared === null || !/^\d+$/.test(declared)) {
      throw new DomainError('invalid', { reason: 'length_required' });
    }
    if (Number(declared) > MAX_UPLOAD_PART_BYTES) {
      throw new DomainError('invalid', { reason: 'file_too_large' });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_PART_BYTES) {
      throw new DomainError('invalid', { reason: 'file_too_large' });
    }
    const stored = await storeUploadPart(
      env.DB,
      env,
      String(params['uploadId']),
      String(params['part']),
      bytes,
      env.OWNER_NAME,
    );
    return json(stored);
  });
