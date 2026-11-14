/** Admin Worker configuration (SEC-05). Admin-only: never imported by public code. */
import { z } from 'zod';
import { EnvironmentName, Origin, OwnerName, checkOriginsMatchEnvironment } from '../config.ts';

export const AdminConfigSchema = z
  .object({
    ENVIRONMENT: EnvironmentName,
    ADMIN_ORIGIN: Origin,
    PUBLIC_ORIGIN: Origin,
    OWNER_NAME: OwnerName,
    /** e.g. https://myteam.cloudflareaccess.com — also the JWT issuer. */
    ACCESS_TEAM_DOMAIN: z
      .string()
      .regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/),
    /** The Access application's AUD tag (64 hex characters). */
    ACCESS_AUD: z.string().regex(/^[a-f0-9]{64}$/),
    /** The only identity allowed into admin (SEC-02/03). A Worker secret, never committed. */
    ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  })
  .superRefine((c, ctx) =>
    checkOriginsMatchEnvironment(c.ENVIRONMENT, [c.ADMIN_ORIGIN, c.PUBLIC_ORIGIN], ctx),
  );
export type AdminConfig = z.infer<typeof AdminConfigSchema>;
