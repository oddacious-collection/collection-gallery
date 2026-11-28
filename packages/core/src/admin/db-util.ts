/** Shared helpers for admin data access: batched writes and audit entries (SEC-13). */
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { auditLog } from '../db/schema.ts';
import { ulid } from '../ids.ts';

export type Db = DrizzleD1Database;
export type Op = BatchItem<'sqlite'>;

/** Runs the operations as one D1 batch (a single transaction). */
export async function run(db: Db, ops: Op[]): Promise<void> {
  const [first, ...rest] = ops;
  if (!first) return;
  await db.batch([first, ...rest]);
}

/** An audit-log insert for one admin mutation. */
export function audit(
  db: Db,
  targetType: 'item' | 'category' | 'media' | 'settings' | 'hashtag_rule',
  actor: string,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
  at: string,
): Op {
  return db.insert(auditLog).values({
    id: ulid(),
    at,
    actorEmail: actor,
    action,
    targetType,
    targetId,
    details: JSON.stringify(details),
  });
}
