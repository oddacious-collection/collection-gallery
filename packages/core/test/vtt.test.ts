/**
 * Caption files (MED-12, D-65): WebVTT and SubRip in, a rebuilt WebVTT out
 * with nothing but timings, safe placement settings and the cue text.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTIONS_MAX_BYTES,
  CaptionsError,
  cleanCueText,
  formatTimestamp,
  parseCaptions,
  parseTimestamp,
} from '../src/media/vtt.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function reason(fn: () => unknown): { reason: string; cue: number | null } | 'no error' {
  try {
    fn();
  } catch (err) {
    if (err instanceof CaptionsError) return { reason: err.reason, cue: err.cue };
    throw err;
  }
  return 'no error';
}

describe('caption timestamps', () => {
  it('reads WebVTT and SubRip times and writes WebVTT times', () => {
    expect(parseTimestamp('00:01.500')).toBe(1.5);
    expect(parseTimestamp('01:02:03.004')).toBeCloseTo(3723.004, 6);
    expect(parseTimestamp('00:00:07,250')).toBe(7.25);
    expect(parseTimestamp('0:61.000')).toBeNull();
    expect(parseTimestamp('00:01.5')).toBeNull();
    expect(formatTimestamp(83.5)).toBe('00:01:23.500');
  });
});

describe('cue text cleaning', () => {
  it('keeps i/b/u, drops other tags and escapes stray markup', () => {
    expect(cleanCueText('<v Bob>Hello</v> <i.loud>there</i>')).toBe('Hello <i>there</i>');
    expect(cleanCueText('<font color="red">Red</font> & <b>bold</b>')).toBe(
      'Red &amp; <b>bold</b>',
    );
    expect(cleanCueText('a < b > c &lt; &amp; &#169;')).toBe('a &lt; b &gt; c &lt; &amp; &#169;');
    expect(cleanCueText('<script>x</script>')).toBe('x');
  });
});

describe('parseCaptions', () => {
  it('rebuilds WebVTT without the header text, notes, styles, regions or identifiers', () => {
    const file = [
      'WEBVTT - private header text',
      'Kind: captions',
      '',
      'NOTE secret-note-text: bought from Pat for $40',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'REGION',
      'id:fred width:40%',
      '',
      'intro-cue-id',
      '00:01.000 --> 00:03.500 align:start region:fred position:10% bogus:1',
      '<v Narrator>This is a <b>meteorite</b>.',
      '',
      '00:00:04.000 --> 00:00:06.000',
      'Second line',
      'and more',
      '',
    ].join('\r\n');
    const { vtt, cues } = parseCaptions(enc(file), 10);
    expect(cues).toBe(2);
    expect(vtt).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:03.500 align:start position:10%',
        'This is a <b>meteorite</b>.',
        '',
        '00:00:04.000 --> 00:00:06.000',
        'Second line',
        'and more',
        '',
      ].join('\n'),
    );
    for (const hidden of [
      'secret-note-text',
      'private header',
      'color: red',
      'intro-cue-id',
      'fred',
      'Narrator',
    ]) {
      expect(vtt).not.toContain(hidden);
    }
  });

  it('converts SubRip, sorts cues and cuts an end past the video', () => {
    const srt = [
      '1',
      '00:00:05,000 --> 00:00:12,000',
      '<font color="#fff">Last</font>',
      '',
      '2',
      '00:00:01,000 --> 00:00:02,000',
      'First',
      '',
    ].join('\n');
    const bom = String.fromCharCode(0xfeff);
    const { vtt, cues } = parseCaptions(enc(`${bom}${srt}`), 8);
    expect(cues).toBe(2);
    expect(vtt).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst\n\n00:00:05.000 --> 00:00:08.000\nLast\n',
    );
  });

  it('refuses files it cannot use, naming the caption at fault', () => {
    expect(reason(() => parseCaptions(enc(''), 10))).toEqual({ reason: 'empty', cue: null });
    expect(reason(() => parseCaptions(enc('WEBVTT\n\nNOTE only a note\n'), 10))).toEqual({
      reason: 'empty',
      cue: null,
    });
    expect(reason(() => parseCaptions(new Uint8Array([0xff, 0xfe, 0x41]), 10))).toEqual({
      reason: 'not_utf8',
      cue: null,
    });
    expect(
      reason(() => parseCaptions(new Uint8Array(CAPTIONS_MAX_BYTES + 1).fill(0x41), 10)),
    ).toEqual({ reason: 'too_large', cue: null });
    expect(reason(() => parseCaptions(enc('WEBVTT\n\njust some words\n'), 10))).toEqual({
      reason: 'bad_block',
      cue: 1,
    });
    expect(
      reason(() =>
        parseCaptions(
          enc('WEBVTT\n\n00:01.000 --> 00:02.000\nok\n\n00:03.000 --> 00:02.000\nbad\n'),
          10,
        ),
      ),
    ).toEqual({ reason: 'bad_timing', cue: 2 });
    expect(reason(() => parseCaptions(enc('WEBVTT\n\n00:01.000 -> 00:02.000\nx\n'), 10))).toEqual({
      reason: 'bad_block',
      cue: 1,
    });
    // Captions made for the untrimmed video.
    expect(
      reason(() => parseCaptions(enc('WEBVTT\n\n00:00:15.000 --> 00:00:16.000\nlate\n'), 10)),
    ).toEqual({ reason: 'starts_after_end', cue: 1 });
    // A missing blank line puts a timing line inside the text.
    expect(
      reason(() =>
        parseCaptions(
          enc('WEBVTT\n\n00:01.000 --> 00:02.000\na\n00:03.000 --> 00:04.000\nb\n'),
          10,
        ),
      ),
    ).toEqual({ reason: 'bad_block', cue: 1 });
  });
});
