/**
 * The Instagram import plan file (D-62, D-70): one entry per post, prepared
 * before the import (proposed title, skip, duplicate group, caption edits)
 * and reviewed by the owner. The file itself is the owner's content and lives
 * next to the export, never in this repository; only its format is here.
 *
 * Posts are matched by their Instagram creation timestamp (seconds), which is
 * stable across exports; `index` (0 = newest in `posts_1.json`) only helps a
 * person find the post.
 */
import { z } from 'zod';

export const PLAN_VERSION = 1;

/** How sure the drafter is that the title is right. */
export const TitleConfidence = z.enum(['high', 'medium', 'low']);

/**
 * import: becomes a draft. skip: not imported (not an object, or a repeat the
 * owner chose against). maybe-skip: imported, but flagged in the review.
 */
export const PostAction = z.enum(['import', 'skip', 'maybe-skip']);

/** Remove this exact text from the cleaned caption (owner-approved edits). */
export const CaptionEdit = z.strictObject({
  remove: z.string().min(1).max(2000),
});

export const PlanPost = z.strictObject({
  index: z.int().min(0).max(100_000),
  timestamp: z.int().min(1_000_000_000).max(4_000_000_000),
  action: PostAction,
  title: z.string().trim().min(1).max(200),
  titleConfidence: TitleConfidence,
  /** Why the title may be wrong, or what to check (review only, never public). */
  note: z.string().max(1000).optional(),
  /** Posts of the same object share a group name; the owner keeps one. */
  duplicateGroup: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
  captionEdits: z.array(CaptionEdit).max(20).optional(),
});
export type PlanPost = z.infer<typeof PlanPost>;

export const ImportPlan = z
  .strictObject({
    version: z.literal(PLAN_VERSION),
    source: z.literal('instagram'),
    posts: z.array(PlanPost).max(100_000),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<number>();
    plan.posts.forEach((p, i) => {
      if (seen.has(p.timestamp)) {
        ctx.addIssue({
          code: 'custom',
          path: ['posts', i, 'timestamp'],
          message: 'two entries for the same post',
        });
      }
      seen.add(p.timestamp);
    });
  });
export type ImportPlan = z.infer<typeof ImportPlan>;

/** Parses and checks a plan file's text; throws a ZodError listing every problem. */
export function parseImportPlan(text: string): ImportPlan {
  return ImportPlan.parse(JSON.parse(text));
}

/** The plan entry for a post, by its timestamp. */
export function planFor(plan: ImportPlan, timestamp: number): PlanPost | undefined {
  return plan.posts.find((p) => p.timestamp === timestamp);
}
