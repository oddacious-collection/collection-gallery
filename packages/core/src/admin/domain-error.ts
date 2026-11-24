/**
 * Expected, user-facing failures of admin operations. Route handlers map
 * `code` to an HTTP status; `details` carries reasons the admin UI can show
 * (never secrets or internals).
 */
export type DomainErrorCode =
  'not_found' | 'invalid' | 'slug_taken' | 'cannot_publish' | 'conflict';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
