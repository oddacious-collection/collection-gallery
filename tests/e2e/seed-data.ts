/**
 * The local data the e2e tests run against (scripts/seed-local.ts writes it).
 * Public items to browse, plus non-public items and admin-only values marked
 * with SENTINEL strings that must never appear on any public surface (INV-1;
 * the full privacy-leak suite, TST-02, builds on these in M1 step 6).
 */

export interface SeedItem {
  title: string;
  slug: string;
  categories: string[];
  tags?: string[];
  description?: string;
  postedAt: string;
  photos: number[];
  /**
   * Videos after the photos (PUB-06): the 2 s fixture with sound
   * (fixtures/seed-video.mp4), with an optional caption file (D-65).
   */
  videos?: Array<{ alt?: string; captions?: string }>;
  status: 'public' | 'private' | 'draft';
  kind?: 'owned' | 'wishlist';
  trashed?: boolean;
  /** Admin-only values that must never leak. */
  secret?: { sourceCaption: string; purchasePriceCents: number };
  /** Created with this slug, then renamed to `slug` (old link → 301). */
  oldSlug?: string;
}

export const SEED_CATEGORIES = [
  { slug: 'meteorites', name: 'Meteorites', parent: null, description: 'Rocks from **space**.' },
  { slug: 'pallasites', name: 'Pallasites', parent: 'meteorites', description: '' },
  { slug: 'books', name: 'Books', parent: null, description: '' },
  {
    slug: 'sentinel-hidden-category',
    name: 'SENTINEL-HIDDEN-CATEGORY',
    parent: null,
    description: '',
  },
] as const;

export const SEED_ITEMS: SeedItem[] = [
  {
    title: 'Seymchan pallasite slice',
    slug: 'seymchan-pallasite-slice',
    categories: ['pallasites'],
    tags: ['Olivine', 'Iron'],
    description: 'Etched slice showing **olivine** crystals.\n\n- Found 1967\n- Magadan, Russia',
    postedAt: '2026-01-05T12:00:00.000Z',
    photos: [0, 1],
    status: 'public',
    secret: { sourceCaption: 'SENTINEL-SOURCE-CAPTION', purchasePriceCents: 987654321 },
  },
  {
    title: 'Gibeon iron meteorite',
    slug: 'gibeon-iron-meteorite',
    categories: ['meteorites'],
    tags: ['Iron'],
    postedAt: '2026-01-04T12:00:00.000Z',
    photos: [1],
    videos: [
      {
        alt: 'Gibeon slice turning in the light',
        // The NOTE is a private comment: the public captions must never carry it.
        captions: [
          'WEBVTT',
          '',
          'NOTE SENTINEL-CAPTION-NOTE paid 987654321',
          '',
          '0:00 - 0:01.5',
          'Gibeon iron, etched',
          '',
        ].join('\n'),
      },
    ],
    status: 'public',
  },
  {
    title: 'Campo del Cielo fragment',
    slug: 'campo-del-cielo-fragment',
    categories: ['meteorites'],
    postedAt: '2026-01-03T12:00:00.000Z',
    photos: [2],
    videos: [{ alt: 'Campo del Cielo fragment on a scale' }],
    status: 'public',
  },
  {
    title: 'First edition Dune',
    slug: 'first-edition-dune',
    oldSlug: 'dune-first-edition-old',
    categories: ['books'],
    tags: ['Science fiction'],
    postedAt: '2026-01-02T12:00:00.000Z',
    photos: [3],
    status: 'public',
  },
  {
    title: 'Signed poetry chapbook',
    slug: 'signed-poetry-chapbook',
    categories: ['books'],
    postedAt: '2026-01-01T12:00:00.000Z',
    photos: [0],
    status: 'public',
  },
  // ---- never public
  {
    title: 'SENTINEL-DRAFT-TITLE',
    slug: 'sentinel-draft',
    categories: ['sentinel-hidden-category'],
    postedAt: '2026-01-06T12:00:00.000Z',
    photos: [0],
    status: 'draft',
  },
  {
    title: 'SENTINEL-PRIVATE-TITLE',
    slug: 'sentinel-private',
    categories: ['sentinel-hidden-category', 'meteorites'],
    postedAt: '2026-01-06T12:00:00.000Z',
    photos: [1],
    videos: [
      {
        alt: 'SENTINEL-VIDEO-ALT',
        captions: ['0:00 - 0:01', 'SENTINEL-PRIVATE-CAPTION'].join('\n'),
      },
    ],
    status: 'private',
  },
  {
    title: 'SENTINEL-WISHLIST-TITLE',
    slug: 'sentinel-wishlist',
    categories: ['sentinel-hidden-category'],
    postedAt: '2026-01-06T12:00:00.000Z',
    photos: [2],
    status: 'draft',
    kind: 'wishlist',
  },
  {
    title: 'SENTINEL-TRASHED-TITLE',
    slug: 'sentinel-trashed',
    categories: ['sentinel-hidden-category', 'books'],
    postedAt: '2026-01-06T12:00:00.000Z',
    photos: [3],
    status: 'public',
    trashed: true,
  },
];

export const PUBLIC_SLUGS = SEED_ITEMS.filter(
  (i) => i.status === 'public' && !i.trashed && i.kind !== 'wishlist',
).map((i) => i.slug);
export const HIDDEN_SLUGS = SEED_ITEMS.filter((i) => !PUBLIC_SLUGS.includes(i.slug)).map(
  (i) => i.slug,
);

/** Strings that must never appear on a public surface. */
export const SENTINELS = ['SENTINEL-', '987654321', '9876543.21', 'owner@example.com'];

/** Written by the seed script: public and hidden media keys, for media tests. */
export interface SeedManifest {
  mediaKeys: Record<string, { variants: string[]; original: string }>;
  /** An unassigned photo in the inbox (D-55): never public. */
  inbox: { variants: string[]; original: string };
}
export const SEED_MANIFEST = '.wrangler/e2e-seed.json';
export const SEED_VIDEO = 'tests/e2e/fixtures/seed-video.mp4';
