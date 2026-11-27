/**
 * Video captions (MED-12, D-65). The owner uploads a WebVTT (.vtt) or SubRip
 * (.srt) file, or a plain .txt written by hand in the same shape with short
 * times (`0:01 - 0:03`, then the text, then a blank line). Only the contents
 * matter, never the file name. The server keeps the file privately as uploaded and publishes
 * a **rebuilt** WebVTT made only of cue timings, a few safe placement settings
 * and the cue text:
 *
 * - `NOTE` comments, `STYLE` and `REGION` blocks, cue identifiers and the
 *   header text are dropped (comments are the obvious place for private
 *   notes, so they are never published);
 * - in the text only `<i>`, `<b>`, `<u>` survive; every other tag (`<v Bob>`,
 *   `<c.red>`, SubRip's `<font …>`) is removed, and `&`/`<` are escaped
 *   unless they are a WebVTT character reference;
 * - cues must start before the video ends; an end past it is cut to the end.
 *
 * Parsing is line by line with simple anchored patterns (no backtracking
 * regexes, CodeQL's polynomial-ReDoS rule).
 */

export const CAPTIONS_MAX_BYTES = 256 * 1024;
export const CAPTIONS_MAX_CUES = 2000;
const MAX_LINE_CHARS = 500;
const MAX_TEXT_LINES = 8;

export type CaptionsErrorReason =
  | 'too_large'
  | 'not_utf8'
  | 'empty'
  | 'bad_block'
  | 'bad_timing'
  | 'starts_after_end'
  | 'too_many_cues'
  | 'line_too_long';

/** A caption file that can't be used; `cue` is the 1-based block number. */
export class CaptionsError extends Error {
  override readonly name = 'CaptionsError';
  readonly reason: CaptionsErrorReason;
  readonly cue: number | null;
  constructor(reason: CaptionsErrorReason, cue: number | null = null) {
    super(cue === null ? reason : `${reason} (block ${cue})`);
    this.reason = reason;
    this.cue = cue;
  }
}

export interface Captions {
  /** The rebuilt public WebVTT file. */
  vtt: string;
  cues: number;
}

interface Cue {
  start: number;
  end: number;
  settings: string;
  text: string[];
}

/**
 * Caption times. WebVTT (`00:01.500`, `00:00:01.500`), SubRip
 * (`00:00:01,500`), and the short forms people type by hand: `0:01`,
 * `1:02.5`, `0:00:07`. Minutes and seconds go up to 59; a fraction has 1 to 3
 * digits (`.5` is half a second).
 */
const TIMESTAMP = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/;

/** Seconds from a caption time, or null if it isn't one. */
export function parseTimestamp(token: string): number | null {
  const m = TIMESTAMP.exec(token);
  if (!m) return null;
  const [, h = '0', min = '0', s = '0', frac = ''] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
}

export function formatTimestamp(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const min = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(min)}:${two(s)}.${String(ms).padStart(3, '0')}`;
}

const SETTINGS: Record<string, RegExp> = {
  align: /^(?:start|center|end|left|right)$/,
  line: /^(?:-?\d{1,3}|\d{1,3}(?:\.\d{1,3})?%)(?:,(?:start|center|end))?$/,
  position: /^\d{1,3}(?:\.\d{1,3})?%(?:,(?:line-left|center|line-right))?$/,
  size: /^\d{1,3}(?:\.\d{1,3})?%$/,
  vertical: /^(?:rl|lr)$/,
};

/** Keeps only well-formed placement settings; drops regions and anything unknown. */
function cleanSettings(tokens: string[]): string {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon <= 0) continue;
    const name = token.slice(0, colon);
    const value = token.slice(colon + 1);
    const pattern = Object.hasOwn(SETTINGS, name) ? SETTINGS[name] : undefined;
    if (!pattern || seen.has(name) || !pattern.test(value)) continue;
    seen.add(name);
    kept.push(`${name}:${value}`);
  }
  return kept.length ? ` ${kept.join(' ')}` : '';
}

/**
 * A timing line, or null if the line isn't one:
 * - WebVTT/SubRip: `start --> end [settings]`;
 * - typed by hand: `start - end` (`0:01 - 0:03`), with nothing after it.
 */
export function parseTiming(line: string): { start: number; end: number; settings: string } | null {
  const arrow = line.indexOf('-->');
  if (arrow < 0) {
    // Times never contain '-', so the first one is the separator.
    const dash = line.indexOf('-');
    if (dash < 0) return null;
    const start = parseTimestamp(line.slice(0, dash).trim());
    const end = parseTimestamp(line.slice(dash + 1).trim());
    return start === null || end === null ? null : { start, end, settings: '' };
  }
  const start = parseTimestamp(line.slice(0, arrow).trim());
  const rest = line
    .slice(arrow + 3)
    .split(/[ \t]/)
    .filter((t) => t !== '');
  const end = rest[0] === undefined ? null : parseTimestamp(rest[0]);
  if (start === null || end === null) return null;
  return { start, end, settings: cleanSettings(rest.slice(1)) };
}

const KEPT_TAGS = new Set(['i', 'b', 'u']);
const ENTITY = /^&(?:amp|lt|gt|lrm|rlm|nbsp|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;

/** Cue text with only `<i>`, `<b>`, `<u>` kept and stray `&`/`<` escaped. */
export function cleanCueText(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '<') {
      // A tag starts right after `<` (`<i>`, `</i>`, `<00:01.000>`); a lone
      // `<` followed by a space is just text.
      const close = /[A-Za-z0-9/]/.test(line[i + 1] ?? '') ? line.indexOf('>', i + 1) : -1;
      if (close < 0) {
        out += '&lt;';
        i += 1;
        continue;
      }
      const inner = line.slice(i + 1, close);
      const closing = inner.startsWith('/');
      // `<i.class>` → `i`; `<v Bob>` → `v`.
      const name = (closing ? inner.slice(1) : inner).split(/[.\s]/, 1)[0]?.toLowerCase() ?? '';
      if (KEPT_TAGS.has(name)) out += closing ? `</${name}>` : `<${name}>`;
      i = close + 1;
      continue;
    }
    if (ch === '&') {
      const m = ENTITY.exec(line.slice(i, i + 12));
      if (m) {
        out += m[0];
        i += m[0].length;
      } else {
        out += '&amp;';
        i += 1;
      }
      continue;
    }
    if (ch === '>') {
      out += '&gt;';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.trim();
}

function blocksOf(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') {
      if (current.length) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function isWord(line: string, word: string): boolean {
  return line === word || line.startsWith(`${word} `) || line.startsWith(`${word}\t`);
}

/**
 * Checks an uploaded caption file against the video's length and returns the
 * public WebVTT. Throws `CaptionsError` for anything it can't use.
 */
export function parseCaptions(bytes: Uint8Array, durationS: number): Captions {
  if (bytes.length > CAPTIONS_MAX_BYTES) throw new CaptionsError('too_large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CaptionsError('not_utf8');
  }
  text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\0', '');
  const blocks = blocksOf(text);
  const first = blocks[0]?.[0];
  if (first === undefined) throw new CaptionsError('empty');
  const isVtt = isWord(first, 'WEBVTT');
  if (isVtt) blocks.shift(); // the header block: never published

  const cues: Cue[] = [];
  blocks.forEach((block, index) => {
    const n = index + 1;
    const head = block[0] as string;
    if (isVtt && (isWord(head, 'NOTE') || head === 'STYLE' || head === 'REGION')) return;
    // A cue: an optional identifier line, then the timing line, then text.
    let at = 0;
    let timing = parseTiming(head);
    if (!timing && block.length > 1 && !head.includes('-->')) {
      at = 1;
      timing = parseTiming(block[1] as string);
    }
    if (!timing) {
      throw new CaptionsError(block.some((l) => l.includes('-->')) ? 'bad_timing' : 'bad_block', n);
    }
    if (timing.end <= timing.start) throw new CaptionsError('bad_timing', n);
    if (timing.start >= durationS) throw new CaptionsError('starts_after_end', n);
    const lines = block.slice(at + 1);
    // A timing line inside the text means a blank line is missing.
    if (lines.some((l) => l.includes('-->') || parseTiming(l) !== null)) {
      throw new CaptionsError('bad_block', n);
    }
    if (lines.some((l) => l.length > MAX_LINE_CHARS)) throw new CaptionsError('line_too_long', n);
    const cleaned = lines
      .slice(0, MAX_TEXT_LINES)
      .map(cleanCueText)
      .filter((l) => l !== '');
    if (cleaned.length === 0) return; // nothing to show
    cues.push({
      start: timing.start,
      end: Math.min(timing.end, durationS),
      settings: timing.settings,
      text: cleaned,
    });
    if (cues.length > CAPTIONS_MAX_CUES) throw new CaptionsError('too_many_cues');
  });
  if (cues.length === 0) throw new CaptionsError('empty');

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const body = cues
    .map(
      (c) =>
        `${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}${c.settings}\n${c.text.join('\n')}`,
    )
    .join('\n\n');
  return { vtt: `WEBVTT\n\n${body}\n`, cues: cues.length };
}
