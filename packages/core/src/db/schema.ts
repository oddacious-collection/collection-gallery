/**
 * Drizzle schema (D1 / SQLite): the data model of REQUIREMENTS §4.
 *
 * Conventions: IDs are ULIDs (text); timestamps are UTC ISO-8601 text; money is
 * integer cents plus an ISO 4217 currency; booleans are 0/1 integers. CHECK
 * constraints repeat the Zod enums so the database itself refuses bad values.
 *
 * Visibility rule (INV-1): public code never imports this module directly. It
 * goes through `@cg/core/public`, which selects allowlisted public fields from
 * publicly visible items only (status = public, kind = owned, not trashed).
 * Columns marked ADMIN below must never appear in a public query.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// ------------------------------------------------------------------- enums

export const ITEM_KINDS = ['owned', 'wishlist'] as const;
export const ITEM_STATUSES = ['draft', 'public', 'private'] as const;
export const WATERMARK_OVERRIDES = ['inherit', 'on', 'off'] as const;
/** Ordered from least to most restrictive (RGT-02). */
export const LICENSES = ['cc-by', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nc-nd', 'arr'] as const;
export const MEDIA_KINDS = ['image', 'video'] as const;
/** What a stored public file is for (MED-05; poster and video arrive in M4). */
export const VARIANT_ROLES = ['image', 'og', 'poster', 'video'] as const;
export const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'date',
  'bool',
  'select',
  'url',
] as const;
export const FIELD_VISIBILITIES = ['public', 'admin'] as const;
export const PROVENANCE_TYPES = [
  'acquired',
  'gifted',
  'appraised',
  'restored',
  'exhibited',
  'other',
] as const;
export const ANALYTICS_METRICS = ['view', 'like'] as const;

const inList = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.join(
    values.map((v) => sql.raw(`'${v.replace(/'/g, "''")}'`)),
    sql`, `,
  )})`;

// ------------------------------------------------------------------- items (§4.1)

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(), // PUBLIC
    kind: text('kind', { enum: ITEM_KINDS }).notNull().default('owned'), // ADMIN
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('draft'), // ADMIN
    title: text('title').notNull(), // PUBLIC
    description: text('description').notNull().default(''), // PUBLIC (restricted Markdown)
    postedAt: text('posted_at'), // PUBLIC; set on first publish
    licenseOverride: text('license_override', { enum: LICENSES }), // PUBLIC (effective license)
    watermarkOverride: text('watermark_override', { enum: WATERMARK_OVERRIDES })
      .notNull()
      .default('inherit'), // ADMIN
    purchasePriceCents: integer('purchase_price_cents'), // ADMIN
    purchaseCurrency: text('purchase_currency'), // ADMIN
    purchaseDate: text('purchase_date'), // ADMIN
    openToParting: integer('open_to_parting', { mode: 'boolean' }).notNull().default(false), // ADMIN
    /** D-42: the imported caption exactly as posted. ADMIN. */
    sourceCaption: text('source_caption'),
    /** D-42: JSON array of hashtag words offered as one-click tags. ADMIN. */
    suggestedTags: text('suggested_tags'),
    createdAt: text('created_at').notNull(), // ADMIN
    updatedAt: text('updated_at').notNull(), // ADMIN
    deletedAt: text('deleted_at'), // ADMIN; set = in trash
  },
  (t) => [
    uniqueIndex('items_slug_unique').on(t.slug),
    index('items_visibility_idx').on(t.status, t.kind, t.deletedAt, t.postedAt),
    index('items_deleted_idx').on(t.deletedAt),
    check('items_kind_check', inList(t.kind, ITEM_KINDS)),
    check('items_status_check', inList(t.status, ITEM_STATUSES)),
    check('items_watermark_check', inList(t.watermarkOverride, WATERMARK_OVERRIDES)),
    check(
      'items_license_check',
      sql`${t.licenseOverride} IS NULL OR ${inList(t.licenseOverride, LICENSES)}`,
    ),
    check(
      'items_price_check',
      sql`${t.purchasePriceCents} IS NULL OR ${t.purchasePriceCents} >= 0`,
    ),
    check(
      'items_currency_check',
      sql`${t.purchaseCurrency} IS NULL OR length(${t.purchaseCurrency}) = 3`,
    ),
    // A wishlist item can never be public (§4.1).
    check(
      'items_wishlist_not_public',
      sql`NOT (${t.kind} = 'wishlist' AND ${t.status} = 'public')`,
    ),
  ],
);

export const slugRedirects = sqliteTable('slug_redirects', {
  oldSlug: text('old_slug').primaryKey(),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// ------------------------------------------------------------------- media (§4.2)

export const media = sqliteTable(
  'media',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    isCover: integer('is_cover', { mode: 'boolean' }).notNull().default(false),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    /** Key in media-private (MED-04): the metadata-free master (D-43). ADMIN. */
    originalKey: text('original_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    durationS: real('duration_s'),
    hasAudio: integer('has_audio', { mode: 'boolean' }).notNull().default(false),
    captionsKey: text('captions_key'), // media-private (MED-12, M4)
    altText: text('alt_text').notNull().default(''), // PUBLIC
    /** SHA-256 of the master, for import de-duplication (IMP-03). ADMIN. */
    contentHash: text('content_hash'),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('media_original_key_unique').on(t.originalKey),
    index('media_item_idx').on(t.itemId, t.position),
    index('media_hash_idx').on(t.contentHash),
    check('media_kind_check', inList(t.kind, MEDIA_KINDS)),
    check('media_dimensions_check', sql`${t.width} > 0 AND ${t.height} > 0`),
  ],
);

/**
 * Public files derived from a media item (MED-05), one row per stored object
 * in media-public. Kept as a table rather than JSON so serving a file is one
 * indexed lookup from its key to the parent item's visibility (MED-10).
 */
export const mediaVariants = sqliteTable(
  'media_variants',
  {
    key: text('key').primaryKey(), // ≥128-bit random, never reused (MED-13)
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    role: text('role', { enum: VARIANT_ROLES }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    format: text('format').notNull(), // MIME type, e.g. image/webp
    bytes: integer('bytes').notNull(),
    watermarked: integer('watermarked', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('media_variants_media_idx').on(t.mediaId),
    check('media_variants_role_check', inList(t.role, VARIANT_ROLES)),
  ],
);

/**
 * A photo upload in progress (D-46). Created when the browser announces a
 * photo; each file is verified and stored as it arrives; finalize turns the
 * upload into a `media` row and deletes this one. Uploads never finalized are
 * removed, with their files, after 24 hours. ADMIN.
 */
export const mediaUploads = sqliteTable(
  'media_uploads',
  {
    id: text('id').primaryKey(), // random key, never reused
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    /** JSON: the planned files, each with its storage key (see admin/media.ts). */
    parts: text('parts').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('media_uploads_created_idx').on(t.createdAt)],
);

// ------------------------------------------------------------------- categories (§4.3)

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => categories.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    /** Globally unique, so a category's URL survives moving it in the tree. */
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    coverMediaId: text('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
    defaultLicense: text('default_license', { enum: LICENSES }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('categories_slug_unique').on(t.slug),
    index('categories_parent_idx').on(t.parentId, t.position),
    check(
      'categories_license_check',
      sql`${t.defaultLicense} IS NULL OR ${inList(t.defaultLicense, LICENSES)}`,
    ),
    check('categories_not_own_parent', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  ],
);

/** Closure table (CNT-03): every ancestor/descendant pair, including self at depth 0. */
export const categoryClosure = sqliteTable(
  'category_closure',
  {
    ancestorId: text('ancestor_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    descendantId: text('descendant_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ancestorId, t.descendantId] }),
    index('category_closure_descendant_idx').on(t.descendantId),
  ],
);

export const itemCategories = sqliteTable(
  'item_categories',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    // ADM-06: a category with items can't be deleted until they're reassigned.
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.categoryId] }),
    index('item_categories_category_idx').on(t.categoryId),
  ],
);

// ------------------------------------------------------------------- tags (§4.6)

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('tags_slug_unique').on(t.slug)],
);

export const itemTags = sqliteTable(
  'item_tags',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] }), index('item_tags_tag_idx').on(t.tagId)],
);

// ------------------------------------------------------------------- custom fields (§4.4)

export const fieldDefinitions = sqliteTable(
  'field_definitions',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: FIELD_TYPES }).notNull(),
    options: text('options'), // JSON array for `select`
    visibility: text('visibility', { enum: FIELD_VISIBILITIES }).notNull().default('admin'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('field_definitions_category_key_unique').on(t.categoryId, t.key),
    check('field_definitions_type_check', inList(t.type, FIELD_TYPES)),
    check('field_definitions_visibility_check', inList(t.visibility, FIELD_VISIBILITIES)),
  ],
);

export const itemFieldValues = sqliteTable(
  'item_field_values',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.fieldId] })],
);

// ------------------------------------------------------------------- collector records (§4.5, ADMIN)

export const valuations = sqliteTable(
  'valuations',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    valueCents: integer('value_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    source: text('source').notNull().default(''),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('valuations_item_idx').on(t.itemId, t.date),
    check('valuations_value_check', sql`${t.valueCents} >= 0`),
    check('valuations_currency_check', sql`length(${t.currency}) = 3`),
  ],
);

export const provenanceEvents = sqliteTable(
  'provenance_events',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    type: text('type', { enum: PROVENANCE_TYPES }).notNull(),
    counterparty: text('counterparty').notNull().default(''),
    description: text('description').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('provenance_events_item_idx').on(t.itemId, t.date),
    check('provenance_events_type_check', inList(t.type, PROVENANCE_TYPES)),
  ],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    provenanceEventId: text('provenance_event_id').references(() => provenanceEvents.id, {
      onDelete: 'set null',
    }),
    key: text('key').notNull(), // media-private, served as attachment only (ABU-04)
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [uniqueIndex('documents_key_unique').on(t.key), index('documents_item_idx').on(t.itemId)],
);

export const permissionGrants = sqliteTable(
  'permission_grants',
  {
    id: text('id').primaryKey(),
    requesterName: text('requester_name').notNull(),
    requesterEmail: text('requester_email').notNull(),
    itemId: text('item_id').references(() => items.id, { onDelete: 'set null' }),
    mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),
    intendedUse: text('intended_use').notNull().default(''),
    creditLine: text('credit_line').notNull().default(''),
    grantedOn: text('granted_on').notNull(),
    terms: text('terms').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('permission_grants_item_idx').on(t.itemId)],
);

/** Inbound contact-form submissions (§5.7, M5). Auto-deleted after 180 days unless linked. */
export const permissionRequests = sqliteTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    receivedAt: text('received_at').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    itemId: text('item_id').references(() => items.id, { onDelete: 'set null' }),
    intendedUse: text('intended_use').notNull().default(''),
    whereUsed: text('where_used').notNull().default(''),
    creditLine: text('credit_line').notNull().default(''),
    message: text('message').notNull().default(''),
    grantId: text('grant_id').references(() => permissionGrants.id, { onDelete: 'set null' }),
  },
  (t) => [index('permission_requests_received_idx').on(t.receivedAt)],
);

// ------------------------------------------------------------------- system (§4.6)

export const itemRevisions = sqliteTable(
  'item_revisions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    snapshot: text('snapshot').notNull(), // JSON (see admin/revisions.ts)
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('item_revisions_item_idx').on(t.itemId, t.createdAt)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    actorEmail: text('actor_email').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    details: text('details').notNull().default('{}'), // JSON
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);

/** Daily aggregates (ANL-01..04, M6). `item_id` '' = site-level. No IPs, ever. */
export const analyticsDaily = sqliteTable(
  'analytics_daily',
  {
    date: text('date').notNull(),
    itemId: text('item_id').notNull().default(''),
    metric: text('metric', { enum: ANALYTICS_METRICS }).notNull(),
    country: text('country').notNull().default(''),
    region: text('region').notNull().default(''),
    referrerHost: text('referrer_host').notNull().default(''),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [t.date, t.itemId, t.metric, t.country, t.region, t.referrerHost],
    }),
    check('analytics_daily_metric_check', inList(t.metric, ANALYTICS_METRICS)),
  ],
);

/** Like de-duplication (ANL-03, M6): daily-rotated HMACs only, purged after 48 h. */
export const likeDedupe = sqliteTable(
  'like_dedupe',
  {
    date: text('date').notNull(),
    itemId: text('item_id').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.itemId, t.hash] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
