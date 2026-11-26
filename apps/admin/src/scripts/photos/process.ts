/**
 * On-device photo processing (MED-02, D-43, D-44, D-48). Runs in the admin's
 * browser before anything is uploaded:
 *
 *   sniff the real file type → decode, applying the camera's orientation →
 *   draw onto a fresh canvas (pixels only: every byte of camera metadata,
 *   GPS included, is left behind) → JPEG master (≤ 4608 px, ≤ 16 MP) and the
 *   public sizes (WebP + a 1200 px JPEG) → strip anything the browser's
 *   encoder adds → check each file exactly as the server will.
 *
 * Images are drawn rather than copied, so nothing from the original file but
 * its pixels can reach the outputs. No DOM is touched except canvases.
 */
import {
  ACCEPTED_IMAGE_INPUTS,
  MIN_EDGE,
  SNIFF_BYTES,
  isJpeg,
  masterSize,
  sniffInput,
  stripJpegMetadata,
  uploadPlan,
  verifyPart,
  type InputKind,
  type PlannedPart,
} from '@cg/core/media';

export type PhotoErrorCode =
  | 'gif'
  | 'video'
  | 'markup'
  | 'unsupported_type'
  | 'heic_unsupported'
  | 'decode_failed'
  | 'too_small'
  | 'encode_failed';

export class PhotoError extends Error {
  override readonly name = 'PhotoError';
  readonly code: PhotoErrorCode;
  constructor(code: PhotoErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** Plain-language explanations for the owner. */
export const PHOTO_ERROR_TEXT: Record<PhotoErrorCode, string> = {
  gif: 'GIF files are not accepted. Use a photo (JPEG, HEIC, PNG, WebP or AVIF).',
  video: 'Videos are not supported yet (they arrive in a later milestone).',
  markup: 'SVG, HTML and similar files are never accepted as photos.',
  unsupported_type: 'This is not a supported photo type (JPEG, HEIC, PNG, WebP or AVIF).',
  heic_unsupported:
    "This HEIC photo couldn't be opened. HEIC works in Safari on iPhone and Mac; in other browsers, save the photo as JPEG first.",
  decode_failed: "This photo couldn't be opened. It may be damaged; try exporting it again.",
  too_small: `This photo is too small (at least ${MIN_EDGE} px on its long edge).`,
  encode_failed: "This browser couldn't convert the photo. Try again, or use another browser.",
};

export type WebpEncoder = (image: ImageData) => Promise<Uint8Array>;

export const JPEG_QUALITY = { original: 0.92, og: 0.85 } as const;

/** What kind of file this really is (MED-01); refuses anything we don't accept. */
export async function checkInput(file: Blob): Promise<InputKind> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const kind = sniffInput(head);
  if (ACCEPTED_IMAGE_INPUTS.has(kind)) return kind;
  if (kind === 'gif' || kind === 'video' || kind === 'markup') throw new PhotoError(kind);
  throw new PhotoError('unsupported_type');
}

/** Decodes with the camera orientation applied (EXIF rotation is honoured, then discarded). */
export async function decodePhoto(file: Blob, kind: InputKind): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoError(kind === 'heic' ? 'heic_unsupported' : 'decode_failed');
  }
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new PhotoError('encode_failed', 'no 2d context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Frees a canvas's memory at once (matters on iPhone). */
function release(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

/**
 * Draws `source` at `width` × `height` on a white background (transparent
 * areas become white, as in the JPEG master). Large reductions are done in
 * halving steps, which looks much sharper than one big step.
 */
export function drawScaled(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  let current: CanvasImageSource = source;
  let cw = sourceWidth;
  let ch = sourceHeight;
  const steps: HTMLCanvasElement[] = [];
  while (cw / 2 >= width && ch / 2 >= height) {
    const step = newCanvas(Math.ceil(cw / 2), Math.ceil(ch / 2));
    const ctx = context(step);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, step.width, step.height);
    ctx.drawImage(current, 0, 0, step.width, step.height);
    steps.push(step);
    current = step;
    cw = step.width;
    ch = step.height;
  }
  const out = newCanvas(width, height);
  const ctx = context(out);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(current, 0, 0, width, height);
  steps.forEach(release);
  return out;
}

async function encodeJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    c.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new PhotoError('encode_failed', 'jpeg');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!isJpeg(bytes)) throw new PhotoError('encode_failed', 'not jpeg');
  // Browsers may add JFIF/ICC/EXIF segments of their own; keep pixels only.
  return stripJpegMetadata(bytes);
}

export interface ProcessedPhoto {
  width: number;
  height: number;
  plan: PlannedPart[];
  files: Map<string, Uint8Array>;
}

/**
 * Makes every file for one photo. `onStep` reports progress (for the UI) and
 * gives the browser a moment to repaint between the slow steps.
 */
export async function processPhoto(
  file: Blob,
  encodeWebp: WebpEncoder,
  onStep: (label: string) => void = () => {},
): Promise<ProcessedPhoto> {
  onStep('Checking the file type');
  const kind = await checkInput(file);
  onStep('Opening the photo');
  const bitmap = await decodePhoto(file, kind);
  let master: HTMLCanvasElement;
  try {
    const size = masterSize(bitmap.width, bitmap.height);
    if (Math.max(size.width, size.height) < MIN_EDGE) throw new PhotoError('too_small');
    master = drawScaled(bitmap, bitmap.width, bitmap.height, size.width, size.height);
  } finally {
    bitmap.close();
  }

  try {
    const plan = uploadPlan(master.width, master.height);
    const files = new Map<string, Uint8Array>();
    for (const part of plan) {
      onStep(`Making the ${partLabel(part)}`);
      await new Promise((r) => setTimeout(r, 0));
      let bytes: Uint8Array;
      if (part.role === 'original') {
        bytes = await encodeJpeg(master, JPEG_QUALITY.original);
      } else {
        const scaled = drawScaled(master, master.width, master.height, part.width, part.height);
        try {
          bytes =
            part.format === 'image/jpeg'
              ? await encodeJpeg(scaled, JPEG_QUALITY.og)
              : await encodeWebp(context(scaled).getImageData(0, 0, part.width, part.height));
        } finally {
          release(scaled);
        }
      }
      const check = verifyPart(bytes, part);
      if (!check.ok) {
        throw new PhotoError(
          'encode_failed',
          `${part.name}: ${check.reason} ${check.detail ?? ''}`,
        );
      }
      files.set(part.name, bytes);
    }
    return { width: master.width, height: master.height, plan, files };
  } finally {
    release(master);
  }
}

/** A plain-language name for one of a photo's files, for progress messages. */
export function partLabel(part: Pick<PlannedPart, 'role' | 'width' | 'height'>): string {
  if (part.role === 'original') return 'full-size copy (private)';
  if (part.role === 'og') return 'link-preview image';
  return `${Math.max(part.width, part.height)} px web size`;
}

/**
 * A video's poster files (D-60): the public photo sizes for one frame,
 * without a private copy (the poster can be made again from the video
 * master). Names match the server's plan: `poster-w400` … and `og`.
 */
export async function processPoster(
  frame: CanvasImageSource,
  width: number,
  height: number,
  encodeWebp: WebpEncoder,
  onStep: (label: string) => void = () => {},
): Promise<Map<string, Uint8Array>> {
  const master = drawScaled(frame, width, height, width, height);
  try {
    const files = new Map<string, Uint8Array>();
    for (const part of uploadPlan(width, height)) {
      if (part.role === 'original') continue;
      onStep(`Making the poster's ${partLabel(part)}`);
      await new Promise((r) => setTimeout(r, 0));
      const scaled = drawScaled(master, width, height, part.width, part.height);
      let bytes: Uint8Array;
      try {
        bytes =
          part.format === 'image/jpeg'
            ? await encodeJpeg(scaled, JPEG_QUALITY.og)
            : await encodeWebp(context(scaled).getImageData(0, 0, part.width, part.height));
      } finally {
        release(scaled);
      }
      const check = verifyPart(bytes, part);
      if (!check.ok) {
        throw new PhotoError('encode_failed', `poster ${part.name}: ${check.reason}`);
      }
      files.set(part.role === 'og' ? 'og' : `poster-${part.name}`, bytes);
    }
    return files;
  } finally {
    release(master);
  }
}
