/**
 * Reading the Instagram export and cleaning captions (IMP-01/02/05, D-42,
 * D-62, D-70). Captions here are made up, in the shapes found in the real
 * export.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanCaption,
  escapeMarkdown,
  fallbackTitle,
  fixMojibake,
  hashtagsIn,
  IMPORT_KEY_PATTERN,
  importKey,
  parseInstagramJson,
} from '../src/import/instagram.ts';

/** How Meta's export stores "’": its UTF-8 bytes as Latin-1 characters. */
const mangle = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));

describe('reading the export JSON', () => {
  it('reads single posts, carousels and reels; never the metadata', () => {
    const posts = [
      {
        media: [
          {
            uri: 'media/posts/1.jpg',
            creation_timestamp: 1_700_000_000,
            title: mangle('A single photo’s caption'),
            media_metadata: { camera_metadata: { has_camera_metadata: true }, latitude: 1 },
          },
        ],
      },
      {
        title: 'Carousel caption',
        creation_timestamp: 1_700_000_100,
        media: [
          { uri: 'media/posts/2.jpg', creation_timestamp: 1_700_000_100, title: '' },
          { uri: 'media/posts/3.mp4', creation_timestamp: 1_700_000_100, title: '' },
        ],
      },
    ];
    const { posts: out, problems } = parseInstagramJson(posts, 'post');
    expect(problems).toEqual([]);
    expect(out).toEqual([
      {
        timestamp: 1_700_000_000,
        caption: 'A single photo’s caption',
        media: [{ path: 'media/posts/1.jpg', kind: 'photo' }],
        source: 'post',
      },
      {
        timestamp: 1_700_000_100,
        caption: 'Carousel caption',
        media: [
          { path: 'media/posts/2.jpg', kind: 'photo' },
          { path: 'media/posts/3.mp4', kind: 'video' },
        ],
        source: 'post',
      },
    ]);
    // Nothing from media_metadata comes through.
    expect(JSON.stringify(out)).not.toMatch(/latitude|camera/);

    const reels = parseInstagramJson(
      {
        ig_reels_media: [
          {
            media: [
              { uri: 'media/reels/2026/9.mp4', creation_timestamp: 1_790_000_000, title: 'Reel' },
            ],
          },
        ],
      },
      'reel',
    );
    expect(reels.posts[0]).toMatchObject({ source: 'reel', media: [{ kind: 'video' }] });
  });

  it('reports odd entries per post instead of failing (IMP-05)', () => {
    const { posts, problems } = parseInstagramJson(
      [
        { media: [{ uri: 'media/posts/ok.jpg', creation_timestamp: 1_700_000_000 }] },
        { media: [{ uri: 'media/posts/x.jpg' }] },
        { media: [{ uri: 'media/posts/notes.txt', creation_timestamp: 1_700_000_001 }] },
        'nonsense',
      ],
      'post',
    );
    expect(posts).toHaveLength(1);
    expect(problems).toEqual([
      'entry 1: no timestamp',
      'entry 2: skipped notes.txt (not a photo or video)',
      'entry 2: no photos or videos',
      'entry 3: not a post',
    ]);
    expect(parseInstagramJson({ something: 'else' }, 'post').problems).toEqual([
      'no posts found in this file',
    ]);
  });
});

describe('captions (D-42, D-62)', () => {
  it('repairs mis-encoded text and leaves good text alone', () => {
    expect(fixMojibake(mangle('It’s “quoted” – café'))).toBe('It’s “quoted” – café');
    expect(fixMojibake('plain ascii')).toBe('plain ascii');
    expect(fixMojibake('already fine: it’s')).toBe('already fine: it’s');
    expect(fixMojibake('Ã© is not always mojibake ÿ')).toBe('Ã© is not always mojibake ÿ');
  });

  it('removes the trailing hashtag block and hashtags ending the last line', () => {
    const c = cleanCaption(
      'Sulfur crystals. It even smells like sulfur.\n.\n.\n#sulfur #minerals #rockhound\n#wunderkammer #collection',
    );
    expect(c.description).toBe('Sulfur crystals. It even smells like sulfur.');
    expect(c.hashtags).toEqual(['sulfur', 'minerals', 'rockhound', 'wunderkammer', 'collection']);
    // Hashtags on the last text line, ending with a lone '#'.
    expect(cleanCaption('Pile of garnets. #garnet #gem #').description).toBe('Pile of garnets.');
  });

  it('keeps inline hashtags as words and digit-only numbering as written', () => {
    const c = cleanCaption(
      '#Orpiment and #calcite from Peru.\n#1 is the oldest, #2 the youngest.\n#oddities',
    );
    expect(c.description).toBe(
      'Orpiment and calcite from Peru.\n#1 is the oldest, #2 the youngest.',
    );
    expect(c.hashtags).toEqual(['orpiment', 'calcite', 'oddities']);
    expect(hashtagsIn('C# and a#b are not hashtags, #real is')).toEqual(['real']);
  });

  it('removes @handles, tidying the spaces they leave', () => {
    const c = cleanCaption('Thanks to @alaskapicker for these. From @artemmortis.\n#clown');
    expect(c.description).toBe('Thanks to for these. From.');
    expect(c.mentionsRemoved).toBe(2);
    expect(cleanCaption('Email me: name@example.com').description).toBe(
      'Email me: name@example.com',
    );
  });

  it("applies the plan's caption edits", () => {
    const c = cleanCaption(
      'Mugshots. #1 Bob, #2 Ted. For extra credit, guess. Just kidding.\n#vintage',
      [{ remove: ' For extra credit, guess.' }, { remove: ' Just kidding.' }],
    );
    expect(c.description).toBe('Mugshots. #1 Bob, #2 Ted.');
  });

  it('escapes what the Markdown would format, so captions show as written', () => {
    expect(escapeMarkdown('*could* drink_from [the tap] a\\b')).toBe(
      '\\*could\\* drink\\_from \\[the tap] a\\\\b',
    );
    expect(cleanCaption('You *could* drink from the tap').description).toBe(
      'You \\*could\\* drink from the tap',
    );
  });
});

describe('titles and import keys', () => {
  it('makes a fallback title from the first words', () => {
    expect(fallbackTitle('Glass plate X-ray of a bullet in the shoulder, 1912. #xray', 1)).toBe(
      'Glass plate X-ray of a bullet in the shoulder, 1912',
    );
    expect(fallbackTitle('#onlytags #here', 1_700_000_000)).toBe('Instagram post 2023-11-14');
  });

  it('builds import keys in the stored form', () => {
    const key = importKey(1_700_000_000, 'a'.repeat(64));
    expect(key).toBe(`ig:1700000000:${'a'.repeat(64)}`);
    expect(IMPORT_KEY_PATTERN.test(key)).toBe(true);
    expect(IMPORT_KEY_PATTERN.test('ig:17:abc')).toBe(false);
  });
});
