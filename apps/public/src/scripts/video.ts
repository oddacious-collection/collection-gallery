/**
 * Videos in carousels and the feed (PUB-06, D-60, D-66). Progressive
 * enhancement: without it, a video is its poster linking to the full-screen
 * view, where the browser's own player plays it.
 *
 * - **Only the video on screen plays.** The most visible video (at least 60%
 *   on screen) plays muted and looping; it pauses when it scrolls away, the
 *   tab is hidden, or another video starts. A video the visitor paused stays
 *   paused until it has left the screen.
 * - **Sound for the visit.** Once the visitor turns sound on (the button over
 *   the video, or the player's own controls), the next videos play with
 *   sound until they mute again. Kept in page memory only: a reload starts
 *   muted, and nothing is stored (PRV-01).
 * - **A pool of players.** A few `<video>` elements are shared and moved over
 *   whichever poster is playing. Besides saving memory, this is what keeps
 *   sound working on iPhone: Safari only lets an element play with sound
 *   after a tap has started it, so the "sound on" tap unlocks every player
 *   in the pool at once, and later videos reuse those unlocked players.
 *   Where the browser still refuses sound, the video plays muted and the
 *   "sound on" button stays.
 * - **No autoplay** when the visitor prefers reduced motion or has asked to
 *   save data: tapping the poster plays it in place.
 * - Captions (D-65) are a `<track>` the player's menu turns on; off by default.
 */

const POOL_SIZE = 3;
const PLAY_RATIO = 0.6;
const STOP_RATIO = 0.3;

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const saveData =
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const autoplay = (): boolean => !motionQuery.matches && !saveData;

/** The visitor's sound choice for this visit (page memory only). */
let soundOn = false;

interface Slot {
  root: HTMLElement;
  link: HTMLAnchorElement | null;
  poster: HTMLImageElement | null;
  hasAudio: boolean;
  ratio: number;
  /** The visitor paused it; don't restart it until it has left the screen. */
  userPaused: boolean;
  failed: boolean;
  player: Player | null;
  sound: HTMLButtonElement | null;
}

interface Player {
  video: HTMLVideoElement;
  slot: Slot | null;
  usedAt: number;
  /** Pauses we cause, so they aren't taken for the visitor's. */
  expectedPauses: number;
}

const slots = new Map<Element, Slot>();
const pool: Player[] = [];
let active: Slot | null = null;
let quietVolumeEvents = 0;

function setMuted(video: HTMLVideoElement, muted: boolean): void {
  if (video.muted === muted) return;
  quietVolumeEvents++;
  video.muted = muted;
}

function pausePlayer(p: Player): void {
  if (p.video.paused) return;
  p.expectedPauses++;
  p.video.pause();
}

function makePlayer(): Player {
  const video = document.createElement('video');
  video.className = 'video-player';
  video.controls = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  const p: Player = { video, slot: null, usedAt: 0, expectedPauses: 0 };
  video.addEventListener('volumechange', () => {
    if (quietVolumeEvents > 0) {
      quietVolumeEvents--;
      return;
    }
    // The visitor used the player's own mute control.
    if (p.slot?.hasAudio) soundOn = !video.muted;
    if (p.slot) updateSound(p.slot);
  });
  video.addEventListener('pause', () => {
    if (p.expectedPauses > 0) {
      p.expectedPauses--;
      return;
    }
    if (p.slot) p.slot.userPaused = true;
  });
  video.addEventListener('play', () => {
    // Whatever starts (autoplay or the visitor), nothing else keeps playing.
    for (const other of pool) if (other !== p) pausePlayer(other);
    if (p.slot) {
      p.slot.userPaused = false;
      active = p.slot;
      updateSound(p.slot);
    }
  });
  video.addEventListener('error', () => {
    const slot = p.slot;
    if (!slot) return;
    // Gone or no longer public: leave the poster (its link still works).
    slot.failed = true;
    detach(p);
    if (active === slot) active = null;
  });
  pool.push(p);
  return p;
}

function detach(p: Player): void {
  const slot = p.slot;
  if (!slot) return;
  pausePlayer(p);
  p.video.remove();
  p.slot = null;
  slot.player = null;
  slot.root.classList.remove('has-player');
  if (slot.link) {
    slot.link.removeAttribute('tabindex');
    slot.link.removeAttribute('aria-hidden');
  }
  if (slot.sound) slot.sound.hidden = true;
}

/** Puts a player over the slot's poster, reusing a free or the least recent one. */
function attach(slot: Slot): Player {
  if (slot.player) return slot.player;
  const p =
    pool.find((x) => x.slot === null) ??
    (pool.length < POOL_SIZE
      ? makePlayer()
      : [...pool].filter((x) => x.slot !== active).sort((a, b) => a.usedAt - b.usedAt)[0]) ??
    makePlayer();
  detach(p);
  const { video } = p;
  video.querySelectorAll('track').forEach((t) => t.remove());
  video.poster = slot.poster?.currentSrc || slot.poster?.src || '';
  video.src = slot.root.dataset['video'] ?? '';
  const captions = slot.root.dataset['captions'];
  if (captions) {
    const track = document.createElement('track');
    track.kind = 'captions';
    track.srclang = 'en';
    track.label = 'English';
    track.src = captions;
    video.appendChild(track);
  }
  video.setAttribute('aria-label', slot.root.dataset['label'] ?? 'Video');
  setMuted(video, !(soundOn && slot.hasAudio));
  slot.root.appendChild(video);
  slot.root.classList.add('has-player');
  // The player is now what the visitor sees and uses; the link underneath
  // (the no-JavaScript route) steps out of the way.
  if (slot.link) {
    slot.link.tabIndex = -1;
    slot.link.setAttribute('aria-hidden', 'true');
  }
  p.slot = slot;
  slot.player = p;
  return p;
}

async function play(slot: Slot): Promise<void> {
  if (slot.failed) return;
  const p = attach(slot);
  p.usedAt = Date.now();
  active = slot;
  for (const other of pool) if (other !== p) pausePlayer(other);
  setMuted(p.video, !(soundOn && slot.hasAudio));
  try {
    await p.video.play();
  } catch {
    // Sound refused (or the play was interrupted): play muted instead and
    // keep the "sound on" button showing.
    if (!p.video.muted && p.slot === slot) {
      setMuted(p.video, true);
      try {
        await p.video.play();
      } catch {
        // Not even muted: the player's own play button is there.
      }
    }
  }
  updateSound(slot);
}

function updateSound(slot: Slot): void {
  const show = slot.hasAudio && slot.player !== null && slot.player.video.muted;
  if (!show) {
    if (slot.sound) slot.sound.hidden = true;
    return;
  }
  if (!slot.sound) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'video-sound';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🔇 ';
    b.appendChild(icon);
    b.appendChild(document.createTextNode('Sound on'));
    b.addEventListener('click', () => turnSoundOn(slot));
    slot.root.appendChild(b);
    slot.sound = b;
  }
  slot.sound.hidden = false;
}

/** The visitor's tap: sound on for this video and the rest of the visit. */
function turnSoundOn(slot: Slot): void {
  soundOn = true;
  while (pool.length < POOL_SIZE) makePlayer();
  const current = attach(slot);
  // Unlock the other players while this tap counts as the visitor's
  // gesture (iOS); `load()` does that without playing anything.
  for (const p of pool) if (p !== current && p.video.paused) p.video.load();
  setMuted(current.video, false);
  current.usedAt = Date.now();
  active = slot;
  void current.video.play().catch(() => {
    setMuted(current.video, true);
    updateSound(slot);
  });
  updateSound(slot);
}

/** Picks the video to play: the most visible one, if it is mostly on screen. */
function choose(): void {
  if (document.hidden) {
    if (active?.player) pausePlayer(active.player);
    return;
  }
  if (active && active.ratio < STOP_RATIO && active.player) pausePlayer(active.player);
  if (!autoplay()) return;
  let best: Slot | null = null;
  for (const s of slots.values()) {
    if (s.failed || s.userPaused || s.ratio < PLAY_RATIO) continue;
    if (!best || s.ratio > best.ratio) best = s;
  }
  if (!best) return;
  if (best === active && best.player && !best.player.video.paused) return;
  void play(best);
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const slot = slots.get(e.target);
      if (!slot) continue;
      slot.ratio = e.isIntersecting ? e.intersectionRatio : 0;
      if (slot.ratio === 0) slot.userPaused = false;
    }
    choose();
  },
  { threshold: [0, STOP_RATIO, PLAY_RATIO, 0.8, 1] },
);

function register(root: HTMLElement): void {
  if (slots.has(root) || !root.dataset['video']) return;
  const slot: Slot = {
    root,
    link: root.querySelector('a'),
    poster: root.querySelector('img'),
    hasAudio: root.dataset['audio'] === '1',
    ratio: 0,
    userPaused: false,
    failed: false,
    player: null,
    sound: null,
  };
  slots.set(root, slot);
  // Tapping the poster plays it here instead of opening the full-screen view.
  slot.link?.addEventListener('click', (e) => {
    if (slot.failed || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    slot.userPaused = false;
    void play(slot);
  });
  observer.observe(root);
}

function scan(node: Document | HTMLElement): void {
  node.querySelectorAll<HTMLElement>('[data-video]').forEach(register);
}

scan(document);
// The feed adds items as the visitor scrolls (scripts/feed.ts).
new MutationObserver((records) => {
  for (const r of records) {
    r.addedNodes.forEach((n) => {
      if (n instanceof HTMLElement) {
        if (n.matches('[data-video]')) register(n);
        scan(n);
      }
    });
  }
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener('visibilitychange', choose);
motionQuery.addEventListener('change', choose);
