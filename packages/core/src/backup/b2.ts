/**
 * A minimal Backblaze B2 native-API client (v4: needed for keys limited to two buckets) for backups (BAK-02 to 05).
 * Only what the backup Worker and `backup:verify` need. No dependency:
 * plain fetch, so tests can stand in a fake B2.
 *
 * Every upload carries an Object Lock retention (governance mode, BAK-04)
 * and asks for server-side encryption (SSE-B2). The job key used here can
 * write, list, read and set retentions, but can't delete or bypass locks
 * (BAK-05): mistakes or a stolen key can only add files, never remove them.
 */

export type Fetch = typeof fetch;

export interface B2Session {
  apiUrl: string;
  downloadUrl: string;
  authorizationToken: string;
  accountId: string;
}

export class B2Error extends Error {
  override readonly name = 'B2Error';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`B2 ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

const AUTH_URL = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';

async function check(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!res.ok) throw new B2Error(res.status, body.code ?? 'unknown', body.message ?? '');
  return body;
}

export async function authorize(
  keyId: string,
  appKey: string,
  f: Fetch = fetch,
): Promise<B2Session> {
  const res = await f(AUTH_URL, {
    headers: { authorization: `Basic ${btoa(`${keyId}:${appKey}`)}` },
  });
  const body = (await check(res)) as {
    accountId: string;
    authorizationToken: string;
    apiInfo: { storageApi: { apiUrl: string; downloadUrl: string } };
  };
  return {
    accountId: body.accountId,
    authorizationToken: body.authorizationToken,
    apiUrl: body.apiInfo.storageApi.apiUrl,
    downloadUrl: body.apiInfo.storageApi.downloadUrl,
  };
}

/**
 * Backblaze expects clients to retry timeouts and "busy" answers: 408, 429
 * and any 5xx (a 524 timeout stopped the first staging run, 2026-11-25), or
 * a network failure. Uploads retry with a fresh upload URL each time.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof B2Error) return err.status === 408 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch could not reach B2
}

/** Attempts per call and the first wait (doubled each time: 1 s, 2 s, 4 s). Tests set the wait to 0. */
export const retryPolicy = { attempts: 4, baseDelayMs: 1000 };

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retryPolicy.attempts || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, retryPolicy.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

async function callOnce<T>(s: B2Session, op: string, payload: unknown, f: Fetch): Promise<T> {
  const res = await f(`${s.apiUrl}/b2api/v4/${op}`, {
    method: 'POST',
    headers: { authorization: s.authorizationToken, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await check(res)) as T;
}

function call<T>(s: B2Session, op: string, payload: unknown, f: Fetch): Promise<T> {
  return withRetry(() => callOnce<T>(s, op, payload, f));
}

/** The bucket's ID, looked up by name (names are in config; IDs stay out of the repo). */
export async function bucketId(
  s: B2Session,
  bucketName: string,
  f: Fetch = fetch,
): Promise<string> {
  const body = await call<{ buckets: Array<{ bucketId: string; bucketName: string }> }>(
    s,
    'b2_list_buckets',
    { accountId: s.accountId, bucketName },
    f,
  );
  const found = body.buckets.find((b) => b.bucketName === bucketName);
  if (!found) throw new B2Error(404, 'bucket_not_found', `no access to bucket ${bucketName}`);
  return found.bucketId;
}

export interface B2File {
  fileName: string;
  fileId: string;
  contentLength: number;
  /** Hex SHA-1 that B2 checked on upload (the backup Worker computed it from the R2 bytes). */
  contentSha1?: string;
  uploadTimestamp: number;
  action: string;
}

/** Every current (visible) file under `prefix`, following pagination. */
export async function listFileNames(
  s: B2Session,
  bucket: string,
  prefix: string,
  f: Fetch = fetch,
): Promise<B2File[]> {
  const out: B2File[] = [];
  let startFileName: string | null = null;
  do {
    const body: { files: B2File[]; nextFileName: string | null } = await call(
      s,
      'b2_list_file_names',
      { bucketId: bucket, prefix, maxFileCount: 1000, ...(startFileName ? { startFileName } : {}) },
      f,
    );
    out.push(...body.files.filter((x) => x.action === 'upload'));
    startFileName = body.nextFileName;
  } while (startFileName);
  return out;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** B2 file names are URL-encoded per path segment. */
function encodeName(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}

export interface UploadOptions {
  contentType: string;
  /** Object Lock: kept (governance mode) until this time. */
  retainUntil: Date;
  /** Recorded on the file (x-bz-info-*); short ASCII values only. */
  info?: Record<string, string>;
}

/** Uploads one file with an Object Lock retention and SSE-B2. */
export async function uploadFile(
  s: B2Session,
  bucket: string,
  fileName: string,
  bytes: Uint8Array,
  opts: UploadOptions,
  f: Fetch = fetch,
): Promise<{ fileId: string }> {
  const sha1 = await sha1Hex(bytes);
  return withRetry(async () => {
    const target = await callOnce<{ uploadUrl: string; authorizationToken: string }>(
      s,
      'b2_get_upload_url',
      { bucketId: bucket },
      f,
    );
    const headers: Record<string, string> = {
      authorization: target.authorizationToken,
      'X-Bz-File-Name': encodeName(fileName),
      'Content-Type': opts.contentType,
      'Content-Length': String(bytes.length),
      'X-Bz-Content-Sha1': sha1,
      'X-Bz-Server-Side-Encryption': 'AES256',
      'X-Bz-File-Retention-Mode': 'governance',
      'X-Bz-File-Retention-Retain-Until-Timestamp': String(opts.retainUntil.getTime()),
    };
    for (const [k, v] of Object.entries(opts.info ?? {}))
      headers[`X-Bz-Info-${k}`] = encodeURIComponent(v);
    const res = await f(target.uploadUrl, {
      method: 'POST',
      headers,
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    const body = (await check(res)) as { fileId: string };
    return { fileId: body.fileId };
  });
}

/** Hides a file (it stays as a prior version until lifecycle rules remove it). */
export async function hideFile(
  s: B2Session,
  bucket: string,
  fileName: string,
  f: Fetch = fetch,
): Promise<void> {
  await call(s, 'b2_hide_file', { bucketId: bucket, fileName }, f);
}

/** Downloads a file by name (used by backup:verify and restores). */
export async function downloadFile(
  s: B2Session,
  bucketName: string,
  fileName: string,
  f: Fetch = fetch,
): Promise<Uint8Array> {
  const res = await f(`${s.downloadUrl}/file/${bucketName}/${encodeName(fileName)}`, {
    headers: { authorization: s.authorizationToken },
  });
  if (!res.ok) await check(res);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Uploads a large file as a stream, so it never has to fit in memory (video
 * masters are up to 100 MB; a Worker has 128 MB). B2 accepts the SHA-1 after
 * the data (`hex_digits_at_end`): the stream is hashed as it passes through
 * and the 40 hex digits are appended. `open` is called again on each retry,
 * since a stream can only be read once. Workers runtime only (DigestStream,
 * FixedLengthStream).
 */
export async function uploadFileStream(
  s: B2Session,
  bucket: string,
  fileName: string,
  size: number,
  open: () => Promise<ReadableStream<Uint8Array>>,
  opts: UploadOptions,
  f: Fetch = fetch,
): Promise<{ fileId: string }> {
  return withRetry(async () => {
    const target = await callOnce<{ uploadUrl: string; authorizationToken: string }>(
      s,
      'b2_get_upload_url',
      { bucketId: bucket },
      f,
    );
    // Workers runtime only (the Node scripts that share this module never upload).
    const { DigestStream } = crypto as unknown as { DigestStream: DigestStreamCtor };
    const digest = new DigestStream('SHA-1');
    const writer = digest.getWriter();
    const hashThrough = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        await writer.write(chunk);
        controller.enqueue(chunk);
      },
      async flush(controller) {
        await writer.close();
        const sha = new Uint8Array(await digest.digest);
        const hex = Array.from(sha, (b) => b.toString(16).padStart(2, '0')).join('');
        controller.enqueue(new TextEncoder().encode(hex));
      },
    });
    const total = size + 40;
    const body = (await open()).pipeThrough(hashThrough).pipeThrough(new FixedLengthStream(total));
    const headers: Record<string, string> = {
      authorization: target.authorizationToken,
      'X-Bz-File-Name': encodeName(fileName),
      'Content-Type': opts.contentType,
      'Content-Length': String(total),
      'X-Bz-Content-Sha1': 'hex_digits_at_end',
      'X-Bz-Server-Side-Encryption': 'AES256',
      'X-Bz-File-Retention-Mode': 'governance',
      'X-Bz-File-Retention-Retain-Until-Timestamp': String(opts.retainUntil.getTime()),
    };
    for (const [k, v] of Object.entries(opts.info ?? {}))
      headers[`X-Bz-Info-${k}`] = encodeURIComponent(v);
    const res = await f(target.uploadUrl, { method: 'POST', headers, body });
    const out = (await check(res)) as { fileId: string };
    return { fileId: out.fileId };
  });
}

type DigestStreamCtor = new (
  algorithm: string,
) => WritableStream<ArrayBuffer | ArrayBufferView> & { readonly digest: Promise<ArrayBuffer> };
