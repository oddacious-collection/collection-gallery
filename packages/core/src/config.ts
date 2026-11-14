/**
 * Runtime configuration, validated with Zod at the trust boundary (SEC-05).
 * Invalid or missing configuration makes the Worker fail closed: it serves
 * generic 500s instead of guessing.
 */
import { z } from 'zod';

export const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export const EnvironmentName = z.enum(ENVIRONMENTS);
export type EnvironmentName = z.infer<typeof EnvironmentName>;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === value ? url : null;
  } catch {
    return null;
  }
}

/** An origin such as `https://example.com` (no path, query or trailing slash). */
export const Origin = z.string().refine((v) => parseOrigin(v) !== null, {
  message: 'must be a bare origin such as https://example.com',
});

export const OwnerName = z.string().trim().min(1).max(100);

/**
 * Deployed environments must use HTTPS, non-local origins; the local
 * environment must use local origins. This stops a deployed Worker from being
 * mislabelled "local" (or vice versa).
 */
export function checkOriginsMatchEnvironment(
  env: EnvironmentName,
  origins: readonly string[],
  ctx: z.RefinementCtx,
): void {
  for (const value of origins) {
    const url = parseOrigin(value);
    if (!url) continue;
    const isLocal = LOCAL_HOSTNAMES.has(url.hostname);
    if (env === 'local' && !isLocal) {
      ctx.addIssue({ code: 'custom', message: `local environment requires a local origin` });
    }
    if (env !== 'local' && (isLocal || url.protocol !== 'https:')) {
      ctx.addIssue({ code: 'custom', message: `${env} requires an https, non-local origin` });
    }
  }
}

export const PublicConfigSchema = z
  .object({
    ENVIRONMENT: EnvironmentName,
    PUBLIC_ORIGIN: Origin,
    OWNER_NAME: OwnerName,
  })
  .superRefine((c, ctx) => checkOriginsMatchEnvironment(c.ENVIRONMENT, [c.PUBLIC_ORIGIN], ctx));
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

// The admin schema lives in admin/config.ts so it never reaches the public
// bundle (checked by scripts/check-public-bundle.ts).

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  /** Field paths only — never values, which may be secret. */
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`Invalid configuration: ${fields.join(', ') || '(root)'}`);
    this.fields = fields;
  }
}

const cache = new WeakMap<object, unknown>();

/**
 * Parses configuration from a Worker `env` object. Results are cached per env
 * object (one per isolate in practice). Throws ConfigError on invalid input.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: object): z.infer<S> {
  const key = env;
  const cached = cache.get(key) as { schema: S; value: z.infer<S> } | undefined;
  if (cached?.schema === schema) return cached.value;
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => i.path.join('.')));
  }
  cache.set(key, { schema, value: result.data });
  return result.data;
}
