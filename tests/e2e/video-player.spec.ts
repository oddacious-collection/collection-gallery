/**
 * The public video player (PUB-06, D-60, D-65, D-66) with the seeded videos:
 * Gibeon (photo, then a video with captions) and Campo del Cielo (photo, then
 * a video), next to each other in the meteorites feed.
 *
 * Playback needs H.264, which Playwright's own Chromium build lacks, so the
 * playing tests run in WebKit (Safari's engine) only; CI's Chromium run still
 * checks the markup.
 */
import { expect, test, type Locator } from '@playwright/test';
import { PUBLIC } from './helpers.ts';

const GIBEON = '/item/gibeon-iron-meteorite?in=meteorites';

const playing = (video: Locator) =>
  video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0);
const muted = (video: Locator) => video.evaluate((v: HTMLVideoElement) => v.muted);

test.describe('video playback (WebKit)', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', "Playwright's Chromium has no H.264");

  test('plays muted only while on screen, and sound carries to the next video', async ({
    page,
  }) => {
    await page.goto(`${PUBLIC}${GIBEON}`);
    const gibeon = page.locator('article[data-slug="gibeon-iron-meteorite"]');
    // The video is slide 2: sideways off screen, so nothing plays yet.
    await expect(gibeon.locator('.video-badge')).toHaveText('▶ 0:02');
    await page.waitForTimeout(500);
    await expect(page.locator('.video-player')).toHaveCount(0);

    await gibeon.locator('[data-next]').click();
    const video = gibeon.locator('.video-player');
    await expect.poll(() => playing(video)).toBe(true);
    expect(await muted(video)).toBe(true);
    await expect(video).toHaveAttribute('aria-label', 'Gibeon slice turning in the light');

    // Captions: the rebuilt public copy, without the owner's private NOTE.
    const track = await video.locator('track[kind="captions"]').getAttribute('src');
    expect(track).toMatch(/^\/media\//);
    const vtt = await (await page.request.get(`${PUBLIC}${track}`)).text();
    expect(vtt).toContain('Gibeon iron, etched');
    expect(vtt).not.toContain('SENTINEL');
    expect(vtt).not.toContain('NOTE');

    // One tap turns sound on.
    const soundOn = gibeon.getByRole('button', { name: 'Sound on' });
    await soundOn.click();
    await expect.poll(() => muted(video)).toBe(false);
    await expect.poll(() => playing(video)).toBe(true);
    await expect(soundOn).toBeHidden();

    // The next item (loaded by the feed): its video plays with sound, and
    // Gibeon's stops once it has left the screen.
    const campo = page.locator('article[data-slug="campo-del-cielo-fragment"]');
    await expect(campo).toHaveCount(1);
    await campo.evaluate((a) => a.scrollIntoView({ block: 'start' }));
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await campo.locator('[data-next]').click();
    const next = campo.locator('.video-player');
    await expect.poll(() => playing(next)).toBe(true);
    expect(await muted(next)).toBe(false);
    // Only one plays.
    expect(
      await page
        .locator('.video-player')
        .evaluateAll((vs) => vs.filter((v) => !(v as HTMLVideoElement).paused).length),
    ).toBe(1);
  });

  test('a video the visitor paused stays paused while it is on screen', async ({ page }) => {
    await page.goto(`${PUBLIC}${GIBEON}`);
    const gibeon = page.locator('article[data-slug="gibeon-iron-meteorite"]');
    await gibeon.locator('[data-next]').click();
    const video = gibeon.locator('.video-player');
    await expect.poll(() => playing(video)).toBe(true);
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    // A small scroll re-runs the on-screen check; it must not restart it.
    await page.evaluate(() => window.scrollBy(0, 40));
    await page.waitForTimeout(800);
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('nothing autoplays; tapping the poster plays it in place', async ({ page }) => {
      await page.goto(`${PUBLIC}${GIBEON}`);
      const gibeon = page.locator('article[data-slug="gibeon-iron-meteorite"]');
      await gibeon.locator('[data-next]').click();
      await page.waitForTimeout(800);
      await expect(page.locator('.video-player')).toHaveCount(0);
      await gibeon.getByRole('link', { name: /^Play video 2/ }).click();
      await expect(page).toHaveURL(/\/item\/gibeon-iron-meteorite\?in=meteorites$/);
      await expect.poll(() => playing(gibeon.locator('.video-player'))).toBe(true);
    });
  });
});

test('without the player, a video opens full screen with the browser controls and captions', async ({
  page,
}) => {
  const res = await page.goto(`${PUBLIC}/item/gibeon-iron-meteorite/photo/2`);
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/Gibeon iron meteorite, video 2 of 2/);
  const video = page.locator('figure video[controls]');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video.locator('source[type="video/mp4"]')).toHaveAttribute('src', /^\/media\//);
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute('label', 'English');
  // The carousel's poster links here (the no-JavaScript route).
  await page.goto(`${PUBLIC}/item/gibeon-iron-meteorite`);
  await expect(page.locator('.video-link').first()).toHaveAttribute(
    'href',
    '/item/gibeon-iron-meteorite/photo/2',
  );
});
