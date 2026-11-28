/**
 * Reading the owner's Instagram export (IMP-01, IMP-02, IMP-05; D-42, D-62,
 * D-70). Pure code (no DOM, no Worker APIs): the admin's browser runs it.
 *
 * Only post content is read: each post's caption, timestamp and media paths.
 * Location, device and camera data (`media_metadata`, EXIF) and everything
 * about other people (comments, messages, followers, likes) is never read.
 */

export interface IgMedia {
  /** Path inside the export zip, e.g. `media/posts/1234.jpg`. */
  path: string;
  kind: 'photo' | 'video';
}

export interface IgPost {
  /** Instagram's creation time, in seconds. Stable across exports. */
  timestamp: number;
  /** The caption, with Meta's mis-encoding repaired. */
  caption: string;
  media: IgMedia[];
  source: 'post' | 'reel';
}

const PHOTO = /\.(jpe?g|png|webp|heic|heif)$/i;
const VIDEO = /\.(mp4|mov|m4v)$/i;

/**
 * Meta's exports store text as UTF-8 bytes read as Latin-1 ("â€™" for "’").
 * Re-reads such text as UTF-8; text that isn't mis-encoded is left alone.
 */
export function fixMojibake(s: string): string {
  if (s === '' || ![...s].every((c) => (c.codePointAt(0) ?? 0) <= 0xff)) return s;
  if (![...s].some((c) => (c.codePointAt(0) ?? 0) >= 0x80)) return s;
  const bytes = Uint8Array.from([...s].map((c) => c.codePointAt(0) ?? 0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return s;
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The posts in one of the export's JSON files: `posts_N.json` (a list of
 * posts) or `reels.json` (`{ ig_reels_media: [...] }`). Tolerates layout
 * changes (IMP-05): anything unexpected is reported, never fatal.
 */
export function parseInstagramJson(
  json: unknown,
  source: 'post' | 'reel',
): { posts: IgPost[]; problems: string[] } {
  const problems: string[] = [];
  const list: unknown[] = Array.isArray(json)
    ? json
    : isObj(json) && Array.isArray(json['ig_reels_media'])
      ? (json['ig_reels_media'] as unknown[])
      : [];
  if (list.length === 0) problems.push('no posts found in this file');
  const posts: IgPost[] = [];
  list.forEach((raw, i) => {
    if (!isObj(raw) || !Array.isArray(raw['media'])) {
      problems.push(`entry ${i}: not a post`);
      return;
    }
    const media = (raw['media'] as unknown[]).filter(isObj);
    const first = media[0];
    const timestamp = num(raw['creation_timestamp']) ?? num(first?.['creation_timestamp']);
    if (timestamp === null) {
      problems.push(`entry ${i}: no timestamp`);
      return;
    }
    const caption = fixMojibake(str(raw['title']) || str(first?.['title']));
    const files: IgMedia[] = [];
    for (const m of media) {
      const path = str(m['uri']).replace(/^\/+/, '');
      if (PHOTO.test(path)) files.push({ path, kind: 'photo' });
      else if (VIDEO.test(path)) files.push({ path, kind: 'video' });
      else if (path)
        problems.push(`entry ${i}: skipped ${path.split('/').pop()} (not a photo or video)`);
    }
    if (files.length === 0) {
      problems.push(`entry ${i}: no photos or videos`);
      return;
    }
    posts.push({ timestamp: Math.trunc(timestamp), caption, media: files, source });
  });
  return { posts, problems };
}

// ------------------------------------------------------------------ captions (D-42, D-62)

export interface CleanedCaption {
  /** For the item's description: cleaned, Markdown-escaped. */
  description: string;
  /** Every hashtag (lower case, no '#', no digit-only numbering), for suggestions. */
  hashtags: string[];
  /** How many @handles were removed (the review flags the post to reread). */
  mentionsRemoved: number;
}

const TAG_MAX = 50;
const isTagChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);
const isDigits = (s: string) => /^\d+$/.test(s);
/** A whitespace-separated token that is only a hashtag (plus trailing punctuation). */
const tagToken = (t: string) => /^#[^\s#]*[.,!]*$/.test(t) && !/^#\d+[.,!]*$/.test(t);
const fillerToken = (t: string) => t === '' || /^[.•·\-_]+$/.test(t);

/** Hashtags anywhere in the text, in order, lower case, without duplicates. */
export function hashtagsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '#' || (i > 0 && isTagChar(text[i - 1] ?? ''))) continue;
    let j = i + 1;
    while (j < text.length && isTagChar(text[j] ?? '')) j++;
    const word = text.slice(i + 1, j).toLowerCase();
    if (word && !isDigits(word) && word.length <= TAG_MAX && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
    i = j - 1;
  }
  return out;
}

/** Escapes what the site's restricted Markdown would format (`* _ [ \`). */
export function escapeMarkdown(s: string): string {
  let out = '';
  for (const ch of s) out += '\\*_['.includes(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * The caption as a description: the trailing hashtag block and hashtags
 * ending the last line removed, inline hashtags kept as words (`#Orpiment` →
 * `Orpiment`), digit-only "hashtags" kept as numbering (`#1`), @handles
 * removed, the plan's owner-approved edits applied, then escaped.
 */
export function cleanCaption(raw: string, edits: Array<{ remove: string }> = []): CleanedCaption {
  let text = fixMojibake(raw).replace(/\r\n?/g, '\n');
  const hashtags = hashtagsIn(text);

  // 1. The trailing block: whole lines of hashtags, dots and bullets.
  const lines = text.split('\n');
  while (lines.length > 0) {
    const tokens = (lines[lines.length - 1] ?? '').trim().split(/\s+/);
    if (tokens.every((t) => fillerToken(t) || tagToken(t))) lines.pop();
    else break;
  }
  // 2. Hashtags (and a lone '#') ending the last text line.
  if (lines.length > 0) {
    const tokens = (lines[lines.length - 1] ?? '').trimEnd().split(' ');
    while (tokens.length > 1 && tagToken(tokens[tokens.length - 1] ?? '')) tokens.pop();
    lines[lines.length - 1] = tokens.join(' ');
  }
  text = lines.join('\n');

  // 3. The plan's edits (owner-approved), every occurrence.
  for (const e of edits) text = text.split(e.remove).join('');

  // 4. Inline hashtags become words; numbering stays.
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '#' && !(i > 0 && isTagChar(text[i - 1] ?? ''))) {
      let j = i + 1;
      while (j < text.length && isTagChar(text[j] ?? '')) j++;
      const word = text.slice(i + 1, j);
      if (word && !isDigits(word)) continue; // drop the '#', keep the word
    }
    out += ch;
  }

  // 5. @handles removed.
  let mentionsRemoved = 0;
  let cleaned = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i] ?? '';
    if (ch === '@' && !(i > 0 && isTagChar(out[i - 1] ?? ''))) {
      let j = i + 1;
      while (j < out.length && /[A-Za-z0-9._]/.test(out[j] ?? '')) j++;
      // A handle can't end with a dot: that's the sentence's full stop.
      while (j > i + 1 && out[j - 1] === '.') j--;
      if (j > i + 1) {
        mentionsRemoved++;
        i = j - 1;
        continue;
      }
    }
    cleaned += ch;
  }

  // 6. Tidy: spaces left by removals, trailing spaces, extra blank lines.
  const tidy = cleaned
    .split('\n')
    .map((l) =>
      l
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ([,.;:!?])/g, '$1')
        .trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { description: escapeMarkdown(tidy), hashtags, mentionsRemoved };
}

/**
 * A title from the caption when the plan has none: its first sentence if
 * that's short, otherwise its first ten words.
 */
export function fallbackTitle(caption: string, timestamp: number): string {
  const words = fixMojibake(caption)
    .replace(/#[^\s#]*/g, '')
    .replace(/@[A-Za-z0-9._]+/g, '')
    .split(/\s+/)
    .filter(Boolean);
  let title = '';
  for (const w of words) {
    const next = title ? `${title} ${w}` : w;
    if (next.length > 80) break;
    title = next;
    if (/[.!?]$/.test(w)) break; // end of the first sentence
  }
  if (!title && words[0]) title = words[0].slice(0, 80);
  if (title && !/[.!?]$/.test(title) && title.split(' ').length > 10) {
    title = title.split(' ').slice(0, 10).join(' ');
  }
  title = title.replace(/[.,;:!?]+$/, '');
  return title || `Instagram post ${new Date(timestamp * 1000).toISOString().slice(0, 10)}`;
}

/** The item's import key (D-70): post time plus the first file's SHA-256 as stored. */
export function importKey(timestamp: number, firstFileSha256: string): string {
  return `ig:${timestamp}:${firstFileSha256}`;
}

export const IMPORT_KEY_PATTERN = /^ig:\d{9,11}:[0-9a-f]{64}$/;
