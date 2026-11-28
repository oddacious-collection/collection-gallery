/**
 * The Instagram importer's server side (IMP-01, IMP-03; D-62, D-70). The
 * owner's browser does the reading and processing; for each post it asks here
 * for the draft to fill:
 *
 * - a post seen for the first time becomes a new **draft** (through the
 *   normal create path, so it has a revision and an audit entry) carrying its
 *   import key and the plan's review flags;
 * - a post already imported gets its existing draft back, with the source
 *   hashes of the files it already has, so a resumed import adds only the
 *   missing ones and never duplicates;
 * - a post whose draft the owner moved to the trash is left alone.
 *
 * Every file then goes through the normal upload path, with its source hash
 * recorded on finalize.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { items, media } from '../db/schema.ts';
import { IMPORT_KEY_PATTERN } from '../import/instagram.ts';
import { PostAction, TitleConfidence } from '../import/plan.ts';
import { createItem } from './items.ts';
import { DESCRIPTION_MAX, TAG_NAME_MAX, TITLE_MAX } from './validation.ts';

export const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The review flags kept on an imported draft (shown in the review queue). */
export const ImportReview = z.strictObject({
  action: PostAction.exclude(['skip']),
  titleConfidence: TitleConfidence,
  note: z.string().max(1000).optional(),
  duplicateGroup: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
  mentionsRemoved: z.int().min(0).max(1000),
  /** The plan had no entry for this post (title made from the caption). */
  notInPlan: z.boolean().optional(),
  /** Set by the review queue (json_set writes 1) once the owner has dealt with it. */
  reviewed: z.union([z.literal(1), z.literal(true)]).optional(),
});
export type ImportReview = z.infer<typeof ImportReview>;

export const ImportedItem = z.strictObject({
  importKey: z.string().regex(IMPORT_KEY_PATTERN),
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX),
  postedAt: z.iso.datetime({ offset: false }),
  sourceCaption: z.string().max(10_000),
  suggestedTags: z.array(z.string().trim().min(1).max(TAG_NAME_MAX)).max(200),
  review: ImportReview,
});
export type ImportedItemInput = z.input<typeof ImportedItem>;

export interface ImportTarget {
  itemId: string;
  /** created: new draft; existing: resume it; trashed: the owner binned it, skip. */
  status: 'created' | 'existing' | 'trashed';
  /** Source hashes of the files this draft already has (removed ones too). */
  sourceHashes: string[];
}

async function findByKey(d1: D1Database, importKey: string): Promise<ImportTarget | null> {
  const db = drizzle(d1);
  const [row] = await db
    .select({ id: items.id, deletedAt: items.deletedAt })
    .from(items)
    .where(eq(items.importKey, importKey))
    .limit(1);
  if (!row) return null;
  const files = await db
    .select({ hash: media.sourceHash })
    .from(media)
    .where(and(eq(media.itemId, row.id)));
  return {
    itemId: row.id,
    status: row.deletedAt === null ? 'existing' : 'trashed',
    sourceHashes: files.flatMap((f) => (f.hash ? [f.hash] : [])),
  };
}

/** The draft for one imported post: new, resumed, or (trashed) left alone. */
export async function startImportedItem(
  d1: D1Database,
  input: ImportedItemInput,
  actor: string,
  now: Date = new Date(),
): Promise<ImportTarget> {
  const data = ImportedItem.parse(input);
  const found = await findByKey(d1, data.importKey);
  if (found) return found;
  try {
    const row = await createItem(
      d1,
      {
        title: data.title,
        description: data.description,
        postedAt: data.postedAt,
        sourceCaption: data.sourceCaption,
        suggestedTags: data.suggestedTags,
      },
      actor,
      now,
      { importKey: data.importKey, importReview: JSON.stringify(data.review) },
    );
    return { itemId: row.id, status: 'created', sourceHashes: [] };
  } catch (err) {
    // A retry after a lost response: the first attempt made it.
    const again = await findByKey(d1, data.importKey);
    if (again) return again;
    throw err;
  }
}

/** An imported draft's review flags, or null for a hand-made item. */
export function importReviewOf(row: { importReview: string | null }): ImportReview | null {
  if (!row.importReview) return null;
  const parsed = ImportReview.safeParse(JSON.parse(row.importReview));
  return parsed.success ? parsed.data : null;
}
