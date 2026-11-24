/**
 * Zod schemas for admin input (SEC-05). Every admin write goes through one of
 * these before touching the database; the database CHECK constraints repeat the
 * enums as a second line of defence.
 */
import { z } from 'zod';
import { ITEM_KINDS, ITEM_STATUSES, LICENSES, WATERMARK_OVERRIDES } from '../db/schema.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../slug.ts';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 20_000;
export const TAG_NAME_MAX = 50;
export const MAX_TAGS_PER_ITEM = 50;
export const MAX_CATEGORIES_PER_ITEM = 50;

const isoDateTime = z.iso.datetime({ offset: false });
const isoDate = z.iso.date();
const slug = z.string().max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN);

/** Fields the owner can set when creating or editing an item. */
const itemFields = {
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX),
  slug,
  kind: z.enum(ITEM_KINDS),
  postedAt: isoDateTime.nullable(),
  licenseOverride: z.enum(LICENSES).nullable(),
  watermarkOverride: z.enum(WATERMARK_OVERRIDES),
  purchasePriceCents: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  purchaseCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  purchaseDate: isoDate.nullable(),
  openToParting: z.boolean(),
  sourceCaption: z.string().max(10_000).nullable(),
  suggestedTags: z.array(z.string().trim().min(1).max(TAG_NAME_MAX)).max(200).nullable(),
};

export const ItemCreate = z.strictObject({
  ...itemFields,
  description: itemFields.description.default(''),
  slug: slug.optional(),
  kind: itemFields.kind.default('owned'),
  postedAt: itemFields.postedAt.default(null),
  licenseOverride: itemFields.licenseOverride.default(null),
  watermarkOverride: itemFields.watermarkOverride.default('inherit'),
  purchasePriceCents: itemFields.purchasePriceCents.default(null),
  purchaseCurrency: itemFields.purchaseCurrency.default(null),
  purchaseDate: itemFields.purchaseDate.default(null),
  openToParting: itemFields.openToParting.default(false),
  sourceCaption: itemFields.sourceCaption.default(null),
  suggestedTags: itemFields.suggestedTags.default(null),
});
export type ItemCreateInput = z.input<typeof ItemCreate>;

/** Every field optional; unknown keys rejected. Status changes use their own call. */
export const ItemUpdate = z.strictObject(itemFields).partial();
export type ItemUpdateInput = z.input<typeof ItemUpdate>;

export const ItemStatus = z.enum(ITEM_STATUSES);

export const TagNames = z
  .array(
    z
      .string()
      .trim()
      .transform((s) => s.replace(/\s+/g, ' '))
      .pipe(z.string().min(1).max(TAG_NAME_MAX)),
  )
  .max(MAX_TAGS_PER_ITEM);

export const IdList = (max: number) => z.array(z.string().min(1).max(32)).max(max);
