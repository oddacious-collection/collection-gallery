/**
 * Generic client-facing errors (SEC-12): fixed bodies, no stack traces, no
 * internal detail. Callers add security headers on the way out.
 */
const MESSAGES = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  500: 'Something went wrong',
} as const;

export type ErrorStatus = keyof typeof MESSAGES;

export function errorResponse(
  status: ErrorStatus,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(`${MESSAGES[status]}\n`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * Structured server log line (SEC-12, PRV-04). Never pass IPs, emails, tokens
 * or other PII in `fields`; log reasons and identifiers only.
 */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
