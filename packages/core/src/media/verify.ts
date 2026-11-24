/**
 * Server-side check of one uploaded file against its planned part (MED-03).
 * Used by the admin Worker before anything is written to storage, and by the
 * browser as a self-check before upload.
 *
 * A file passes only if:
 * - its bytes are the planned format (magic bytes and full structure);
 * - it has no trailing data (no polyglots) and no metadata at all;
 * - its pixel size is exactly the planned size;
 * - it is within the size limit.
 */
import { FormatError } from './bytes.ts';
import { isJpeg, parseJpeg } from './jpeg.ts';
import type { PlannedPart } from './plan.ts';
import { isWebp, parseWebp } from './webp.ts';

export type VerifyReason =
  'empty' | 'too_large' | 'wrong_type' | 'malformed' | 'has_metadata' | 'wrong_size';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyReason; detail?: string };

export function verifyPart(bytes: Uint8Array, part: PlannedPart): VerifyResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > part.maxBytes) return { ok: false, reason: 'too_large' };
  try {
    let info: { width: number; height: number; metadata: unknown[] };
    if (part.format === 'image/jpeg') {
      if (!isJpeg(bytes)) return { ok: false, reason: 'wrong_type' };
      info = parseJpeg(bytes);
    } else {
      if (!isWebp(bytes)) return { ok: false, reason: 'wrong_type' };
      info = parseWebp(bytes);
    }
    if (info.metadata.length > 0) return { ok: false, reason: 'has_metadata' };
    if (info.width !== part.width || info.height !== part.height) {
      return {
        ok: false,
        reason: 'wrong_size',
        detail: `${info.width}x${info.height}, expected ${part.width}x${part.height}`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof FormatError) return { ok: false, reason: 'malformed', detail: err.reason };
    throw err;
  }
}
