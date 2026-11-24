/**
 * Helpers for the admin JSON API (SEC-05, SEC-12).
 *
 * - Request bodies must be JSON and are size-capped before parsing.
 * - Expected failures (DomainError, Zod validation) become clear 4xx JSON
 *   responses the admin UI can show. Field paths and Zod messages are safe to
 *   return; nothing internal is.
 * - Anything else is rethrown so the pipeline answers with a generic 500.
 */
import { z } from 'zod';
import { DomainError, type DomainErrorCode } from './domain-error.ts';

export const MAX_JSON_BYTES = 64 * 1024;

const STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid: 400,
  slug_taken: 409,
  cannot_publish: 409,
  conflict: 409,
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new DomainError('invalid', { reason: 'content_type' });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new DomainError('invalid', { reason: 'too_large' });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new DomainError('invalid', { reason: 'too_large' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('invalid', { reason: 'json' });
  }
}

/** Runs an API handler, turning expected failures into JSON 4xx responses. */
export async function api(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof DomainError) {
      return json({ error: err.code, ...err.details }, STATUS[err.code]);
    }
    if (err instanceof z.ZodError) {
      return json(
        {
          error: 'invalid',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    throw err;
  }
}
