/** Image URLs and responsive attributes (MED-05, NFR-01). */
import type { PublicImage } from '@cg/core/public';

/**
 * Public photo files are served by this Worker under /media/ (D-25: staging
 * uses a path on the public host; a separate media host arrives with the
 * domain move in M7).
 */
export function mediaUrl(key: string): string {
  return `/media/${key}`;
}

export function srcset(img: PublicImage): string {
  return img.sources.map((s) => `${mediaUrl(s.key)} ${Math.max(s.width, 1)}w`).join(', ');
}

/** The smallest source at least `width` pixels wide (or the largest there is). */
export function sourceFor(img: PublicImage, width: number): string {
  const s = img.sources.find((x) => x.width >= width) ?? img.sources[img.sources.length - 1];
  return s ? mediaUrl(s.key) : '';
}

export function largest(img: PublicImage) {
  return img.sources[img.sources.length - 1] ?? null;
}
