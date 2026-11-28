/**
 * The Instagram import page (IMP-01 to 05, D-62, D-70). Reads the export zip
 * piece by piece (never whole) and the import plan, then for each post:
 *
 *   plan says skip → note it
 *   otherwise → hash its first file (import key) → ask the server for the
 *   draft (new, resumed or left alone if trashed) → each file it doesn't
 *   have yet: photo or video pipeline → upload → finalize with its hash
 *
 * One bad post or file is reported and the run carries on (IMP-05). Stop is
 * honoured between files; running again resumes. The screen is kept awake.
 * Messages use textContent only (Trusted Types).
 */
import {
  cleanCaption,
  fallbackTitle,
  importKey,
  parseImportPlan,
  parseInstagramJson,
  planFor,
  readZipDirectory,
  readZipEntry,
  ZipError,
  type IgPost,
  type ImportPlan,
  type RandomAccess,
  type ZipEntry,
} from '@cg/core/import';
import { PHOTO_ERROR_TEXT, PhotoError } from '../photos/process.ts';
import { VIDEO_ERROR_TEXT, VideoError } from '../video/process.ts';
import { send, sendCaptions, sendPhoto, sendVideo, SendError } from './send.ts';

const $ = <T extends Element>(root: Document | HTMLElement, sel: string) =>
  root.querySelector<T>(sel);

function fileSource(file: File): RandomAccess {
  return {
    size: file.size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function reasonOf(err: unknown): string {
  if (err instanceof PhotoError) return PHOTO_ERROR_TEXT[err.code];
  if (err instanceof VideoError) return VIDEO_ERROR_TEXT[err.code];
  if (err instanceof SendError) return err.message;
  if (err instanceof ZipError) return `The export file is damaged here (${err.reason}).`;
  return 'Something went wrong with this one.';
}

async function keepAwake(): Promise<() => void> {
  try {
    const lock = await navigator.wakeLock.request('screen');
    return () => void lock.release();
  } catch {
    return () => {};
  }
}

interface Loaded {
  src: RandomAccess;
  entries: Map<string, ZipEntry>;
  posts: IgPost[];
  plan: ImportPlan | null;
  problems: string[];
  missing: number;
}

/** Finds a file by its path in the export, tolerating an extra top folder (IMP-05). */
function entryFor(entries: Map<string, ZipEntry>, path: string): ZipEntry | undefined {
  const exact = entries.get(path);
  if (exact) return exact;
  for (const [name, e] of entries) if (name.endsWith(`/${path}`)) return e;
  return undefined;
}

/** The one .srt next to a reel's video, if there is exactly one (the export doesn't link them). */
function subtitleFor(entries: Map<string, ZipEntry>, videoEntry: string): ZipEntry | undefined {
  const dirOf = (name: string) => name.slice(0, name.lastIndexOf('/') + 1);
  const dir = dirOf(videoEntry);
  const srts = [...entries.values()].filter(
    (e) => e.name.toLowerCase().endsWith('.srt') && dirOf(e.name) === dir,
  );
  return srts.length === 1 ? srts[0] : undefined;
}

async function load(zip: File, planFile: File | null): Promise<Loaded> {
  const src = fileSource(zip);
  const list = await readZipDirectory(src);
  const entries = new Map(list.map((e) => [e.name, e]));
  const problems: string[] = [];
  const posts: IgPost[] = [];
  for (const e of list) {
    const base = e.name.slice(e.name.lastIndexOf('/') + 1);
    const source = /^posts_\d+\.json$/.test(base) ? 'post' : base === 'reels.json' ? 'reel' : null;
    if (!source) continue;
    const text = new TextDecoder().decode(await readZipEntry(src, e));
    const parsed = parseInstagramJson(JSON.parse(text), source);
    posts.push(...parsed.posts);
    problems.push(...parsed.problems.map((p) => `${base}: ${p}`));
  }
  if (posts.length === 0) {
    throw new Error('No Instagram posts found. Is this the JSON export from Meta?');
  }
  posts.sort((a, b) => b.timestamp - a.timestamp);
  const plan = planFile ? parseImportPlan(await planFile.text()) : null;
  const missing = posts.flatMap((p) => p.media).filter((m) => !entryFor(entries, m.path)).length;
  return { src, entries, posts, plan, problems, missing };
}

type Outcome = 'imported' | 'resumed' | 'done' | 'skipped' | 'trashed' | 'failed';

function init(root: HTMLElement): void {
  const zipInput = $<HTMLInputElement>(root, '[data-import-zip]');
  const planInput = $<HTMLInputElement>(root, '[data-import-plan]');
  const limitInput = $<HTMLInputElement>(root, '[data-import-limit]');
  const checkBtn = $<HTMLButtonElement>(root, '[data-import-check]');
  const message = $<HTMLElement>(root, '[data-import-message]');
  const summary = $<HTMLElement>(document, '[data-import-summary]');
  const facts = $<HTMLElement>(document, '[data-import-facts]');
  const startBtn = $<HTMLButtonElement>(document, '[data-import-start]');
  const stopBtn = $<HTMLButtonElement>(document, '[data-import-stop]');
  const bar = $<HTMLProgressElement>(document, '[data-import-progress]');
  const now = $<HTMLElement>(document, '[data-import-now]');
  const reportCard = $<HTMLElement>(document, '[data-import-report-card]');
  const report = $<HTMLElement>(document, '[data-import-report]');
  const totals = $<HTMLElement>(document, '[data-import-totals]');
  if (
    !zipInput ||
    !planInput ||
    !limitInput ||
    !checkBtn ||
    !message ||
    !summary ||
    !facts ||
    !startBtn ||
    !stopBtn ||
    !bar ||
    !now ||
    !reportCard ||
    !report ||
    !totals
  ) {
    return;
  }

  let loaded: Loaded | null = null;
  let stopped = false;
  let cancel: (() => Promise<void>) | null = null;
  const say = (el: HTMLElement, text: string, ok = true) => {
    el.textContent = text;
    el.classList.toggle('error', !ok);
  };
  const fact = (text: string) => {
    const li = document.createElement('li');
    li.textContent = text;
    facts.appendChild(li);
  };

  const posts = () => {
    if (!loaded) return [];
    const n = Number.parseInt(limitInput.value, 10);
    return Number.isFinite(n) && n > 0 ? loaded.posts.slice(0, n) : loaded.posts;
  };

  checkBtn.addEventListener('click', () => {
    const zip = zipInput.files?.[0];
    if (!zip) {
      say(message, 'Choose the export .zip first.', false);
      return;
    }
    checkBtn.disabled = true;
    say(message, 'Reading the export…');
    void (async () => {
      try {
        loaded = await load(zip, planInput.files?.[0] ?? null);
        facts.replaceChildren();
        const all = loaded.posts;
        const files = all.flatMap((p) => p.media);
        const videos = files.filter((m) => m.kind === 'video').length;
        fact(
          `${all.length} posts with ${files.length} files (${files.length - videos} photos, ${videos} videos).`,
        );
        if (loaded.plan) {
          const plan = loaded.plan;
          const byAction = { import: 0, 'maybe-skip': 0, skip: 0, none: 0 };
          for (const p of all) byAction[planFor(plan, p.timestamp)?.action ?? 'none']++;
          fact(
            `Plan: ${byAction.import} to import, ${byAction['maybe-skip']} flagged maybe-skip, ${byAction.skip} skipped.`,
          );
          if (byAction.none)
            fact(`${byAction.none} posts aren't in the plan: their titles come from the caption.`);
        } else {
          fact('No plan: every post is imported, titled from its caption.');
        }
        if (loaded.missing)
          fact(`${loaded.missing} files are missing from the zip; those posts will report it.`);
        if (loaded.problems.length)
          fact(`${loaded.problems.length} odd entries were left out (listed in the report).`);
        if (typeof VideoEncoder === 'undefined' && videos > 0) {
          fact(
            'This browser can’t make videos here; posts with videos will fail. Use Chrome, Edge, Firefox or Safari.',
          );
        }
        const limit = posts().length;
        if (limit < all.length) fact(`Trial run: only the first ${limit} posts (newest first).`);
        fact('Everything is imported as a draft: nothing is published.');
        summary.hidden = false;
        say(message, 'Export checked.');
      } catch (err) {
        loaded = null;
        summary.hidden = true;
        say(
          message,
          err instanceof ZipError
            ? 'That file isn’t a readable zip.'
            : err instanceof Error && /plan|version|posts/i.test(err.message)
              ? `The plan file can’t be used: ${err.message.slice(0, 200)}`
              : err instanceof Error
                ? err.message.slice(0, 200)
                : 'The export couldn’t be read.',
          false,
        );
      } finally {
        checkBtn.disabled = false;
      }
    })();
  });

  stopBtn.addEventListener('click', () => {
    stopped = true;
    stopBtn.disabled = true;
    say(now, 'Stopping after the current file…');
    void cancel?.();
  });

  const counts: Record<Outcome, number> = {
    imported: 0,
    resumed: 0,
    done: 0,
    skipped: 0,
    trashed: 0,
    failed: 0,
  };
  const showTotals = () => {
    totals.textContent =
      `New: ${counts.imported}. Resumed: ${counts.resumed}. Already complete: ${counts.done}. ` +
      `Skipped by the plan: ${counts.skipped}. In the trash, left alone: ${counts.trashed}. Failed: ${counts.failed}.`;
  };
  const row = (post: IgPost, title: string, outcome: Outcome, detail: string, itemId?: string) => {
    counts[outcome]++;
    const li = document.createElement('li');
    li.className = `import-${outcome}`;
    const when = new Date(post.timestamp * 1000).toISOString().slice(0, 10);
    if (itemId) {
      const a = document.createElement('a');
      a.href = `/items/${encodeURIComponent(itemId)}`;
      a.textContent = title;
      li.appendChild(a);
    } else {
      li.appendChild(document.createTextNode(title));
    }
    li.appendChild(document.createTextNode(` (${when}): ${detail}`));
    report.appendChild(li);
    showTotals();
  };

  async function importPost(l: Loaded, post: IgPost, status: (s: string) => void): Promise<void> {
    const entry = l.plan ? planFor(l.plan, post.timestamp) : undefined;
    const cleaned = cleanCaption(post.caption, entry?.captionEdits ?? []);
    const title = entry?.title ?? fallbackTitle(post.caption, post.timestamp);
    if (entry?.action === 'skip') {
      row(post, title, 'skipped', entry.note ?? 'Skipped by the plan.');
      return;
    }
    const firstEntry = entryFor(l.entries, post.media[0]?.path ?? '');
    if (!firstEntry) {
      row(post, title, 'failed', `File missing from the zip: ${post.media[0]?.path ?? '?'}`);
      return;
    }
    status('Reading the first file');
    const firstBytes = await readZipEntry(l.src, firstEntry);
    const key = importKey(post.timestamp, await sha256(firstBytes));
    const target = (await send(
      'POST',
      '/api/import/items',
      JSON.stringify({
        importKey: key,
        title,
        description: cleaned.description,
        postedAt: new Date(post.timestamp * 1000).toISOString(),
        sourceCaption: post.caption,
        suggestedTags: cleaned.hashtags,
        review: {
          action: entry?.action === 'maybe-skip' ? 'maybe-skip' : 'import',
          titleConfidence: entry?.titleConfidence ?? 'low',
          ...(entry?.note ? { note: entry.note } : {}),
          ...(entry?.duplicateGroup ? { duplicateGroup: entry.duplicateGroup } : {}),
          mentionsRemoved: cleaned.mentionsRemoved,
          ...(entry ? {} : { notInPlan: true }),
        },
      }),
    )) as unknown as {
      itemId: string;
      status: 'created' | 'existing' | 'trashed';
      sourceHashes: string[];
    };
    if (target.status === 'trashed') {
      row(post, title, 'trashed', 'You moved this draft to the trash; left alone.', target.itemId);
      return;
    }
    const have = new Set(target.sourceHashes);
    let added = 0;
    const notes: string[] = [];
    for (const [i, m] of post.media.entries()) {
      if (stopped) throw new Error('stopped');
      const label = `file ${i + 1} of ${post.media.length}`;
      const e = i === 0 ? firstEntry : entryFor(l.entries, m.path);
      if (!e) {
        notes.push(`${label} missing from the zip`);
        continue;
      }
      const bytes = i === 0 ? firstBytes : await readZipEntry(l.src, e);
      const hash = await sha256(bytes);
      if (have.has(hash)) continue;
      const name = m.path.slice(m.path.lastIndexOf('/') + 1);
      try {
        if (m.kind === 'photo') {
          await sendPhoto(target.itemId, new Blob([bytes as Uint8Array<ArrayBuffer>]), hash, (s) =>
            status(`${label}: ${s}`),
          );
        } else {
          const video = await sendVideo(
            target.itemId,
            new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'video/mp4' }),
            hash,
            (s) => status(`${label}: ${s}`),
            (c) => (cancel = c),
          );
          cancel = null;
          if (video.trimmed) notes.push(`${label}: longer than 2 minutes, first 2 minutes kept`);
          const srt = post.source === 'reel' ? subtitleFor(l.entries, e.name) : undefined;
          if (srt && video.mediaId) {
            try {
              await sendCaptions(video.mediaId, await readZipEntry(l.src, srt));
              notes.push('captions added from the export');
            } catch (err) {
              notes.push(`captions not added: ${reasonOf(err)}`);
            }
          }
        }
        have.add(hash);
        added++;
      } catch (err) {
        if (stopped && err instanceof VideoError && err.code === 'cancelled') {
          throw new Error('stopped', { cause: err });
        }
        notes.push(`${label} (${name}): ${reasonOf(err)}`);
      }
    }
    const failedFiles = notes.filter((n) => !/captions added|first 2 minutes/.test(n)).length;
    const outcome: Outcome =
      failedFiles > 0
        ? 'failed'
        : target.status === 'created'
          ? 'imported'
          : added > 0
            ? 'resumed'
            : 'done';
    const what = added ? `${added} file${added === 1 ? '' : 's'} added` : 'nothing new';
    row(
      post,
      title,
      outcome,
      [what, ...notes].join('; ') + (failedFiles ? '. Run the import again to retry.' : '.'),
      target.itemId,
    );
  }

  startBtn.addEventListener('click', () => {
    const l = loaded;
    if (!l) return;
    const list = posts();
    stopped = false;
    startBtn.disabled = true;
    checkBtn.disabled = true;
    zipInput.disabled = true;
    planInput.disabled = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    bar.hidden = false;
    reportCard.hidden = false;
    report.replaceChildren();
    for (const k of Object.keys(counts) as Outcome[]) counts[k] = 0;
    for (const p of l.problems) {
      const li = document.createElement('li');
      li.className = 'import-failed';
      li.textContent = `Left out: ${p}`;
      report.appendChild(li);
    }
    void (async () => {
      const release = await keepAwake();
      try {
        for (const [i, post] of list.entries()) {
          if (stopped) break;
          bar.value = i / list.length;
          const prefix = `Post ${i + 1} of ${list.length}`;
          say(now, prefix);
          try {
            await importPost(l, post, (s) => say(now, `${prefix}: ${s}`));
          } catch (err) {
            if (err instanceof Error && err.message === 'stopped') break;
            const title =
              (l.plan ? planFor(l.plan, post.timestamp)?.title : undefined) ??
              fallbackTitle(post.caption, post.timestamp);
            row(post, title, 'failed', `${reasonOf(err)} Run the import again to retry.`);
          }
        }
        bar.value = stopped ? bar.value : 1;
        say(
          now,
          stopped
            ? 'Stopped. Run the import again to carry on where it left off.'
            : 'Finished. Imported posts are drafts: review them in Items → Drafts.',
          counts.failed === 0,
        );
      } finally {
        release();
        cancel = null;
        stopBtn.hidden = true;
        startBtn.disabled = false;
        checkBtn.disabled = false;
        zipInput.disabled = false;
        planInput.disabled = false;
      }
    })();
  });
}

const root = document.querySelector<HTMLElement>('[data-import]');
if (root) init(root);
