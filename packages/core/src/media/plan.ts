/**
 * Which files one photo becomes (D-43, MED-04, MED-05). The browser and the
 * server compute the same plan from the master's size, and the server accepts
 * exactly these files and nothing else.
 *
 * - `original`: the metadata-free JPEG master, long edge ≤ 4608 px and at most
 *   16 MP (iPhone Safari's canvas limit is 16.7 MP), stored privately.
 * - `w400` … `w2048`: public WebP derivatives by long edge, never larger than
 *   the master.
 * - `og`: one public JPEG, long edge 1200 px, for link previews.
 */

export const MASTER_MAX_EDGE = 4608;
export const MASTER_MAX_PIXELS = 16_000_000;
export const MIN_EDGE = 200;
export const DERIVATIVE_EDGES = [400, 800, 1200, 1600, 2048] as const;
export const OG_EDGE = 1200;

/** MED-03 size limits per stored file, in bytes. */
export const MAX_BYTES = {
  original: 30 * 1024 * 1024,
  image: 8 * 1024 * 1024,
  og: 5 * 1024 * 1024,
} as const;

export type PartRole = 'original' | 'image' | 'og';
export type PartFormat = 'image/jpeg' | 'image/webp';

export interface PlannedPart {
  /** "original", "w400" … "w2048", "og". */
  name: string;
  role: PartRole;
  format: PartFormat;
  width: number;
  height: number;
  maxBytes: number;
}

/** The master's size for a decoded image of `width` × `height` (never upscaled). */
export function masterSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    MASTER_MAX_EDGE / Math.max(width, height),
    Math.sqrt(MASTER_MAX_PIXELS / (width * height)),
  );
  if (scale === 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Size with the long edge set to `edge` (≤ the master's), aspect kept. */
export function scaledTo(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (edge >= long) return { width, height };
  const f = edge / long;
  return width >= height
    ? { width: edge, height: Math.max(1, Math.round(height * f)) }
    : { width: Math.max(1, Math.round(width * f)), height: edge };
}

export class PlanError extends Error {
  override readonly name = 'PlanError';
  readonly reason: 'too_small' | 'too_large';
  constructor(reason: 'too_small' | 'too_large') {
    super(reason);
    this.reason = reason;
  }
}

/** Every file for a master of the given size. Throws PlanError if out of bounds. */
export function uploadPlan(width: number, height: number): PlannedPart[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PlanError('too_small');
  }
  if (Math.max(width, height) < MIN_EDGE) throw new PlanError('too_small');
  const m = masterSize(width, height);
  if (m.width !== width || m.height !== height) throw new PlanError('too_large');

  const parts: PlannedPart[] = [
    {
      name: 'original',
      role: 'original',
      format: 'image/jpeg',
      width,
      height,
      maxBytes: MAX_BYTES.original,
    },
  ];
  const seen = new Set<number>();
  for (const edge of DERIVATIVE_EDGES) {
    const size = scaledTo(width, height, edge);
    const long = Math.max(size.width, size.height);
    if (seen.has(long)) continue;
    seen.add(long);
    parts.push({
      name: `w${long}`,
      role: 'image',
      format: 'image/webp',
      ...size,
      maxBytes: MAX_BYTES.image,
    });
  }
  parts.push({
    name: 'og',
    role: 'og',
    format: 'image/jpeg',
    ...scaledTo(width, height, OG_EDGE),
    maxBytes: MAX_BYTES.og,
  });
  return parts;
}
