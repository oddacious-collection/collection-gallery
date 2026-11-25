/**
 * Backup Worker entry (D-47, BAK-02 to BAK-06). Scheduled only: there is no
 * fetch handler, so it can't be reached over HTTP even if a route were added
 * by mistake (Cloudflare answers with an error).
 *
 * On failure it emails the owner (BAK-06) and rethrows, so the run is also
 * marked failed in Cloudflare's cron history. Before the owner has finished
 * setup (docs/runbooks/backup-setup.md, part B) the configuration check fails
 * and is only logged.
 */
import { BackupConfigSchema, alertText, runBackup } from '@cg/core/backup';
import { loadConfig } from '@cg/core/config';
import { logEvent } from '@cg/core/errors';

interface Env {
  DB: D1Database;
  MEDIA_PRIVATE: R2Bucket;
  EMAIL: SendEmail;
  ENVIRONMENT: string;
  ALERT_FROM: string;
  ALERT_TO?: string;
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
  B2_DB_BUCKET: string;
  B2_MEDIA_BUCKET: string;
}

async function alert(env: Env, kind: string, error: unknown, now: Date): Promise<void> {
  if (!env.ALERT_TO) {
    logEvent('warn', 'backup_alert_skipped', { reason: 'no_recipient' });
    return;
  }
  const { subject, text } = alertText(env.ENVIRONMENT, kind, error, now);
  try {
    await env.EMAIL.send({ to: env.ALERT_TO, from: env.ALERT_FROM, subject, text });
  } catch (err) {
    logEvent('error', 'backup_alert_failed', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
}

export default {
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    const kind = 'full';
    try {
      const config = loadConfig(BackupConfigSchema, env);
      await runBackup(config, env, kind, now);
    } catch (err) {
      logEvent('error', 'backup_failed', {
        kind,
        reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      await alert(env, kind, err, now);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
