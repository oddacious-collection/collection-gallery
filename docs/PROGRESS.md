# Progress

## Status: M2 Import / export — kickoff approved 2026-11-27 (M1 complete 2026-11-25; M4 complete 2026-11-26; SBOM and scans D-67 and the design milestone D-68 done 2026-11-27).

## M2 Import / export (in progress)

Kickoff approved 2026-11-27 with the recommended answers (D-69 to D-72): import into staging now and move to production at M7 with the restore tooling; the import runs in the admin on the owner's desktop, resumable and idempotent; videos over 120 s imported as their first 120 s and flagged; Instagram's downsized photos imported as they are; Claude drafts the import plan file (reading the remaining captions with the stop-and-ask rule) and the owner reviews it. D-42 and D-62 settled the caption, hashtag, title and review rules earlier.

**Exit criteria (§12):** the owner's real Instagram export imports as drafts with no duplicates on re-run; CSV round trip works; full archive downloads.

### Plan (one PR per step; each goes through CI and staging)

1. [x] Kickoff docs: D-69 to D-72, this plan.
2. [ ] Import plan file: format in the repo (`@cg/core/import`, `packages/core/src/import/plan.ts`: matched by Instagram timestamp; import / skip / maybe-skip, title with confidence, note, duplicate group, caption edits); content (titles with confidence, skip / maybe-skip, duplicate groups, caption edits, video durations) drafted by Claude next to the export, never in the repo; owner review.
3. [ ] Data: admin-only import key on items and source hash on media (migration), hashtag rules table; leak-suite coverage.
4. [ ] Importer in the admin: zip and plan file read in the browser (fflate), each post a draft through the photo and video pipelines, captions cleaned and escaped, the reel's `.srt` as captions, wake lock, per-post report, resumable.
5. [ ] Review screens: one draft at a time (Publish & next / Save & next / Skip), hashtag rules by frequency, bulk checkbox actions in the draft list.
6. [ ] CSV/JSON export and import with dry-run preview (IMP-06, D-71).
7. [ ] Full archive download, streamed by the admin Worker (IMP-07, D-72).
8. [ ] Tests: caption cleaning, mis-encoding repair, hashtags, idempotency, CSV escaping; e2e with a small made-up export; leak suite.
9. [ ] Owner exit test on staging (real export, re-run adds nothing, CSV round trip, archive) and the M2 review.

### Owner tasks for M2

- [ ] Keep the original Instagram export zip and tell Claude where it is.
- [ ] Review the import plan file (step 2), especially uncertain titles.
- [ ] Run the import from the desktop on staging (step 9), then the exit test.

## Design milestone (complete 2026-11-27; before M2, owner request)

Owner decisions 2026-11-26/27 (D-68): neutral grey in light mode with a charcoal header and footer (slate: "looks like a default page"; sage: "a bit sickly"), charcoal in dark mode, following the device setting; photos carry the colour, one cool accent, a touch of bronze under titles; rounded cards, matted photos, pill buttons at least 44 px; device serif titles.

1. [x] Public site restyled with the new colour, type and shape tokens (`apps/public/src/styles/global.css`); two cards per row on phones; axe checks every public page in dark mode too.
2. [x] Owner looks at it on staging with real photos (phone and desktop, light and dark); adjustments. Round 1 (2026-11-26): charcoal approved; slate replaced by sage. Round 2 (2026-11-27): sage replaced by neutral grey with the charcoal header.
3. [x] Admin restyled with the same look (2026-11-27): grey/charcoal, charcoal top bar in both modes, serif page titles, rounded cards, pill buttons with a charcoal (dark: near-white) main button, white fields with a stronger outline; status colours keep their meanings. axe run by hand on the main admin screens in light and dark (the e2e admin runs behind Access, so automated admin checks need a test harness first).
4. [ ] Optional, **deferred** (owner undecided on a font, 2026-11-27): a self-hosted serif (open licence) if the device serifs look too different across phones and computers. When wanted: show the same title in a few free serifs side by side; the file is checked against its published hash and listed in the SBOM.

## M4 Video (complete 2026-11-26; built before M2, D-59)

Kickoff 2026-11-25. The owner approved D-59 to D-62: M4 before M2, videos up to 120 s with trimming, a private master plus the public file, chunked uploads, playback in every current browser (H.264 + AAC MP4), Mediabunny for video processing, and the Instagram import plan (built in M2).

**Exit criteria (§12, D-59):**

- A 120 s iPhone clip uploads from the phone.
- It plays muted; the sound preference carries to the next video; it plays in Safari, Chrome, Edge, Firefox and DuckDuckGo.
- No location or other metadata in any stored file.
- Range requests work in Safari.

### Plan (one PR per step; each goes through CI and staging)

1. [x] Kickoff docs: D-59 to D-62, this plan.
2. [x] Device test page in the staging admin (`/tools/video-check`), run by the owner 2026-11-25: iPhone Safari reads its HEVC 1080p camera clips and converts 166 s in 25 s, stripping Apple's `meta`/`keys`/`ilst` boxes and extra tracks; the iOS photo picker hands over a shrunk 360×480 copy unless Options → Format → Current (the setting sticks); the owner's desktop is Firefox 159: H.264 fine, no HEVC decoding (camera clips go up from the phone, or Chrome/Edge), no AAC encoder (AAC sound copied, D-64). Fixes found: screen wake lock on admin (D-63), copy AAC sound (D-64).
3. [x] Server: chunked upload into R2 multipart (8 MiB chunks; `media_upload_chunks`, migration 0005); chunk 0 (the header) checked completely before storing (`media/mp4.ts`: top level exactly ftyp/moov/mdat, allow-listed boxes, zero timestamps, plain-text names, one H.264 + at most one AAC track, ≤120 s, ≤1080p, samples tiling `mdat` exactly so no hidden bytes); declared size/duration/sound must match; poster files checked like photos; finalize completes the files and adds a `video` media row with `video`/`poster`/`og` variants; Range serving (from M1) with the visibility rule; stale uploads aborted. Backups stream files over 16 MiB to B2 with the SHA-1 at the end (video masters don't fit a Worker's memory).
4. [x] Uploader (item editor, "Add a video"): reads the file on the device (size, length, sound; can't-read message for HEVC in Firefox; warning for iOS shrunk copies), poster chosen with a slider and live frame preview, or from six quick picks (canvases, no `blob:` media); "Set start here" / "Set end here" trim by eye, with a note if the poster falls outside the trim, start/end trim (2:00 max; trimming the start re-makes the sound, refused with a clear message where the browser has no AAC encoder), "Remove sound" (MED-09); makes the master and the public file (bitrate scaled to picture size and never above the source, ≤95 MB, rotation baked in, no tags, zero timestamps), checks both with the server's MP4 check, makes the poster images with the photo pipeline, uploads in chunks with retries, screen kept awake. Tried locally end to end (end trim with sound copied; start trim with sound re-made). Video thumbnails and length shown in the editor's list.
   - [x] Step 4b: captions per video (MED-12, D-65): a .txt (typed by hand: `0:01 - 0:03`, the words, an empty line), .vtt or .srt file added, replaced, downloaded or removed in the editor; the file as uploaded stays private; the public copy is rebuilt as plain WebVTT (no comments, styles, identifiers or unknown tags; migration 0006 adds the `captions` file role). Video downloads now save as .mp4 (they were mislabelled .jpg).
5. [x] Public player (PUB-06, D-66): videos join the item carousel as their poster ("▶ 0:20" badge) linking to the full-screen view, where the browser's own player plays them with captions (the no-JavaScript route). `scripts/video.ts` plays the video most on screen in place (muted, looping), pauses it when it leaves the screen, the tab is hidden or another starts, and respects a visitor's pause; "Sound on" carries to the next videos for the rest of the visit (page memory only); a pool of three shared players also unlocks sound on iPhone from that one tap; no autoplay with reduced motion or Save-Data (tap plays in place). Cards, covers and link previews use the poster. Tested in WebKit desktop and iPhone emulation with a 2 s seeded clip (`tests/e2e/fixtures/seed-video.mp4`, synthetic, made with the uploader): plays muted only on screen, sound carries to the next item's video, only one plays, a paused video stays paused, reduced motion, full-screen fallback. The seed adds a public video with captions (whose private NOTE must never appear) and a private video (sentinel), and the leak crawler now follows the player's `data-video`/`data-captions` files. Still to check on a real iPhone: sound carrying to the next video (step 7).
6. [x] Tests: refusals (too long, too large, wrong type, not fast start, metadata, hidden bytes, wrong sizes: unit tests since step 3; a non-video file gets "can’t be read as a video" in the uploader); **location never stored**: a unit test refuses every place an iPhone or camera writes location (Apple `meta`/`keys`/`ilst` ISO 6709 key, `udta/©xyz`, inside tracks), and on 2026-11-26 a clip carrying Apple-format location, a title and a 2020 date went through the real uploader (built-in browser) and both stored files had none of it, no metadata boxes and a fast-start layout. CI browsers can’t run the conversion (Playwright’s WebKit on Windows has no WebCodecs, its Chromium no H.264), so the server and the uploader’s own self-check enforce it on every upload; a real iPhone clip with location on is optional (the owner keeps location off). Playback rules (TST-06) in WebKit desktop and iPhone emulation; leak suite covers video files and captions (step 5).
7. [x] Owner exit test on iPhone (2026-11-26: upload, muted autoplay, sound carried to the next video without another tap); M4 review below.

### Owner tasks for M4

- [x] Run the device test page on the iPhone and the desktop browser (step 2, done 2026-11-25).
- [x] Exit test: a 2-minute iPhone clip, uploaded from the phone (2026-11-26).
- [x] Play a public video once in Firefox on the desktop (owner, 2026-11-26: it worked).

### M4 review summary (2026-11-26)

**Built** (steps 1 to 7 above, PRs #32 to #38):

- **Uploader:** videos up to 2 minutes are converted on the owner's device to H.264 + AAC MP4. A poster and the trim are picked with a slider, and sound can be removed. Uploads go in resumable 8 MiB chunks and are checked completely by the server before anything is stored.
- **Captions:** a `.txt`, `.vtt` or `.srt` file per video. The public copy is rebuilt, so comments never get out.
- **Public player:** muted autoplay of the video on screen, one at a time. "Sound on" lasts for the visit, including on iPhone. The full-screen view works without JavaScript.
- **Backups:** large files stream to Backblaze, and video masters are backed up like photo masters.

**Exit criteria:** all met.

| Criterion                                                   | Evidence                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 120 s iPhone clip uploads from the phone                  | Owner exit test 2026-11-26 (staging)                                                                                                                                                                                                                                                         |
| Plays muted; the sound preference carries to the next video | Owner exit test on iPhone 2026-11-26 (the second video played with sound without another tap); WebKit e2e tests (desktop and iPhone emulation)                                                                                                                                               |
| Plays in Safari, Chrome, Edge, Firefox and DuckDuckGo       | One format every current browser plays (H.264 + AAC MP4, D-60). Seen playing on iPhone Safari (owner), in WebKit (e2e tests) and in Chromium (built-in browser; Chrome, Edge and DuckDuckGo on Windows use the same engine, DuckDuckGo on iPhone uses Safari's). Firefox: owner check below. |
| No location or other metadata in any stored file            | Every stored video file passes the server's header check, which refuses any metadata box (unit tests include every place an iPhone writes location); a location-tagged clip through the real uploader came out clean (step 6)                                                                |
| Range requests work in Safari                               | Unit tests (206 / 416 / suffix ranges); iPhone Safari playback, which needs them                                                                                                                                                                                                             |

**Deviations:** D-59 to D-66 in §13:

- M4 was built before M2 (D-59).
- Videos are kept as a private master plus the public file, uploaded in chunks (D-60).
- Mediabunny handles video in the browser (D-61).
- The Instagram import plan is settled, for M2 (D-62).
- The screen is kept awake on admin only (D-63).
- AAC sound is copied unchanged, with no WebAssembly fallback (D-64). In Firefox, trimming the start of a video with sound asks to remove the sound or to use another browser.
- Captions are rebuilt for the public site and accept hand-written `.txt` (D-65, owner request).
- The player uses a pool of three shared players (D-66).

**Found and fixed along the way:**

- **Firefox:** Mediabunny's AAC fallback was blocked by our CSP (D-64).
- **iPhone picker:** the iOS photo picker sends a shrunk copy unless Format is set to Current. The editor now warns about it.
- **Timestamps:** Mediabunny writes the current time unless told not to.
- **Downloads:** "Download original" saved videos as `.jpg`.
- **Screen readers:** the video link's spoken name didn't include its visible length.

**New dependency:** `mediabunny` (admin browser code only, see the table below).

**Owner follow-ups:**

- Review this summary.
- Open a public video once in **Firefox on your desktop**: it should play like on the iPhone. That's the one browser in the exit criteria nobody has watched a video in yet.
- Optional: a real iPhone clip with location turned on. Location stays off on your phone, so this is only a final confirmation.
- Dependabot PR #30 (astro-cloudflare group) is still open.

**Carried into later milestones:**

- **M5:** the watermark, by re-making public videos from their masters (MED-06).
- **M7:** moving media to its own host, which needs CORS plus `crossorigin` for the player and captions (D-66). A second caption language, if ever wanted.

**Next:** SBOM and scheduled security scans (owner request), then the design milestone, then M2 Import / export.

### Owner requests (2026-11-25), placed by Claude: SBOM and scheduled scans right after M4 (small, and the bot builds on them); design milestone after that, before M2; the IR/appsec bot after M2, folded into M7 hardening if it fits better there

- **Design milestone** (after M4, before M2): the owner sends 3–5 sites they like; Claude proposes 2–3 design directions as mockups with real items; the chosen one is built as design tokens and components (self-hosted open-licence fonts, PRV-02; dark mode; accessibility checked).
- [x] **SBOM** (D-67, 2026-11-26): CycloneDX from `npm sbom` plus every pinned Action and the ZAP image (`scripts/sbom.ts`), on every staging deploy, kept 90 days as a run artifact. Fonts join it when the design milestone adds them.
- [x] **Scheduled scans** (D-67, 2026-11-26): weekly CodeQL, ZAP against staging (`zap-staging.yml`, also after each deploy) and an OSV scan of the lockfile (`osv-scan.yml`; reviewed exceptions with an expiry in `osv-scanner.toml`), plus a weekly heartbeat that switches every scheduled workflow back on and fails if one was paused or is overdue. How-to: `docs/runbooks/security-scans.md`.
- **IR / appsec bot** (after the SBOM): a scheduled Claude agent reads vulnerability feeds (OSV, GitHub advisories, CISA KEV, vendor notices), checks impact against the SBOM, and opens a GitHub issue with a response plan (detect, assess, contain, eradicate, recover, post-mortem), optionally a fix PR for review. Read access plus issue creation only; feed content treated as data. Cost estimate before building.

## M1 Core gallery (complete 2026-11-25)

Kickoff 2026-11-23. The owner approved decisions D-42 to D-49 (D-49: the owner is named only by a pen name, currently Insignificant Nobody), the D-21/D-22/D-26 amendments, and this plan.

**Exit criteria (§12):**

- The owner photographs an item on iPhone, publishes it, and sees it publicly.
- Toggling it private removes it everywhere within 60 s.
- TST-02 passes.
- The restore drill succeeds.

### Plan (one PR per step; each goes through CI and staging)

1. [x] Kickoff docs: decisions D-42 to D-48, the D-22 correction, the threat model and this plan.
2. [x] Data model, all of §4 (unit tests 80 → 106):
   - migrations, including the admin-only `source_caption` and hashtag suggestions (D-42);
   - ULIDs, slugs with redirects, revision snapshots, audit log, Zod schemas;
   - public and admin data-access layers.
3. [x] Admin items (unit tests 106 → 115; reorder/move via buttons, D-50):
   - create, edit, publish, Public/Private toggle;
   - trash with restore and 30-day auto-purge;
   - revision history with diff and restore;
   - category tree (cycle-safe, multi-category, CNT-01 to 03);
   - assigning tags.
4. [x] Photo pipeline (MED-01 to 05, 07, 13; D-51, D-52; unit tests 116 → 169, e2e 22 → 25 per browser):
   - on-device processing in the admin: real file type sniffed (SVG, GIF, video refused with a clear message), decoded with orientation applied, redrawn from pixels (all metadata left behind), JPEG master at 4608 px / 16 MP or less, WebP 400–2048 (libwebp WASM) plus a 1200 px JPEG for Open Graph; HEIC works where Safari decodes it, elsewhere a clear message (D-48);
   - upload through the admin Worker, one request per file, retried on network errors; each file verified **before** it is stored (type, structure, no trailing data, no metadata, exact size, limits); creator/copyright added by the server from the pen name; finalize attaches everything in one batch with a revision and audit entry;
   - editor: add photos (camera or library on iPhone), thumbnails, alt text, make cover, ↑/↓, remove (restorable 30 days), download the private master; cover thumbnails in the item list;
   - daily cron also purges photos removed > 30 days and uploads unfinished > 24 h;
   - admin CSP adds `'wasm-unsafe-eval'` only (D-44); migration `0002_media_uploads`.
5. [x] Public site (PUB-01/04/05/07/08/15, MED-10; D-53, D-54; unit tests 169 → 183, e2e 25 → 44 per browser):
   - home (collections with covers, recently posted), all items, category pages (breadcrumbs, subcategories, items including subcategories with a toggle), paging;
   - item page with a swipeable photo carousel (arrows, ←/→, counter) and a full-screen photo view; restricted Markdown descriptions; category trails and tags;
   - vertical feed: neighbouring items load as you scroll (2 ahead), the URL follows the item on screen, ↑/↓ and on-screen buttons, Back returns to the list; plain links without JavaScript (1.8 KB of JS, gzipped);
   - search (FTS5 index of public data only, kept in sync in the same batch as every admin change; words-only queries; rate-limited, D-53);
   - photo files served only for public items, with Range and conditional requests (MED-10);
   - identical 404 for every non-public or unknown item, category or photo; old slugs 301; canonical URLs and basic Open Graph;
   - local seed data with sentinels (`npm run db:seed:local`), used by CI e2e.

**5b. [x] Photo inbox** (D-55, owner request 2026-11-24; unit tests 183 → 188, e2e 51 → 53 per browser):

- Inbox page: bulk upload (same pipeline and checks), grid of waiting photos, tap to pick in order (numbered; #1 becomes the cover), "Create draft…" dialog (title + category, remembered for the next draft), Remove (30-day restore);
- "Add from the inbox" in the item editor; "Recently used" list; inbox count in the admin nav; daily cron purges removed inbox photos;
- privacy: inbox photos live in their own table, which no public query reads; core and e2e tests confirm none of their files are reachable publicly.

6. [x] Privacy-leak suite (TST-02, D-56): sentinel seed (`tests/leak/sentinels.sql`) covering every admin-only column, hidden items of each kind, private photos, an inbox photo and a private old slug; a crawler over every page, photo, search and feed fragment, also checking all private storage keys and internal IDs from the database; two phases with items flipped private ↔ public; a self-check that proves it catches a planted leak. Runs in CI as a deploy gate (`npm run leak:local`) and against staging after every deploy (`npm run leak:staging`).
7. [x] Backups (D-47, D-58), live on staging 2026-11-25 (first daily, monthly and full photo copies verified by `backup:verify`):
   - backup Worker `cg-backup-staging` (routeless, hourly cron): database export to B2 once a day (`daily/`, locked 30 days) and once a month (`monthly/`, locked 365 days); `media-private` synced to a versioned bucket (locked 365 days; deleted originals hidden, kept a year); SSE-B2; the job key can't delete; email alert on failure (Cloudflare Email Sending);
   - `npm run backup:verify` (newest export fresh and readable, monthly copy present, every private original in the backup) plus a weekly GitHub workflow, gated on `BACKUPS_ENABLED`;
   - `npm run db:export` / `db:restore` (round trip tested: export, wipe, restore, identical);
   - runbooks: backup-setup, restore-db (with troubleshooting for alert emails), restore-media, emergency-purge, rotate-secrets (BAK-07);
   - B2 calls retry timeouts and busy answers (408, 429, 5xx: a 524 stopped the first run); one photo that still fails no longer stops the others, and the run then alerts. Uses B2 native API v4 (keys limited to two buckets need it).
8. [x] Restore drill (BAK-08), the owner's iPhone exit test, and the M1 review (2026-11-25):
   - `npm run restore:drill` + `restore-drill.yml` (on demand and quarterly): newest B2 export into a scratch staging D1 database, compared row for row; every backed-up private file downloaded and checked (SHA-1, photo size); scratch database deleted. Runbook `docs/runbooks/restore-drill.md`;
   - the trial run found that D1's remote import doesn't keep deferred foreign keys across a file: the restore SQL now loads parents first and fills forward links (category parents, covers) in afterwards, and checks `PRAGMA foreign_key_check`.
   - full drill passed on GitHub 2026-11-25 (23/23 tables identical, 9/9 private files intact);
   - leak suite on staging now ends with both toggle items private, so between runs the only public test item is "Leak test public item" (owner request).

### M1 review summary (2026-11-25)

**Built** (steps 1 to 8 above, PRs #14 to #29): the full data model; admin items with trash, revisions and the category tree; the on-device photo pipeline (all metadata stripped, verified on arrival) and the photo inbox; the public site (home, collections, categories, item pages with carousel, vertical feed, search, Open Graph, 404s); the privacy-leak suite as a deploy gate and a post-deploy staging check; off-site backups to Backblaze with Object Lock, failure emails, a weekly check and a quarterly restore drill. Unit tests 80 → 198; e2e on Chromium and WebKit with axe.

**Exit criteria:** all met.

| Criterion                                                        | Evidence                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Owner photographs an item on iPhone, publishes, sees it publicly | Owner exit test 2026-11-25                                                                    |
| Toggling private removes it everywhere ≤ 60 s                    | Owner exit test; leak suite phase B (no edge caching in M1, D-45, so removal is immediate)    |
| TST-02 passes                                                    | Leak suite green locally (deploy gate) and on staging after every deploy                      |
| Restore drill succeeds                                           | GitHub run 45711747467: 23/23 tables identical, 9/9 private files intact (`restore-drill.md`) |

**Deviations:** D-42 to D-58 in §13. The notable ones: buttons instead of drag-and-drop for categories (D-50); verify each photo on arrival (D-51); one shared search rate-limit key (D-53); the photo inbox (D-55, owner request); prices in US dollars only (D-57); backup alerts by Cloudflare Email Sending, B2 API v4 (D-58).

**Found and fixed along the way:** the first backup run stopped on a Backblaze timeout (retries added); restoring onto a real D1 database would have failed on foreign keys (restore SQL reordered). Both were caught by the checks built in this milestone.

**Owner follow-ups:**

- review this summary;
- Dependabot PR #30 (astro-cloudflare group) to triage;
- desktop HEIC conversion (deferred, after using the inbox for a while);
- the quarterly restore drill runs by itself (2 Jan/Apr/Jul/Oct); GitHub emails if it fails.

**Carried into later milestones:** search rate-limit pricing to recheck before launch (D-53); public photo regeneration after a media restore (M5, `restore-media.md`); tag rename/merge, filters and sorts (M3).

**Next:** M2 Import / export (IMP-01 to 07): the Instagram export imported as drafts, CSV round trip, full archive download.

### Owner feedback

- 2026-11-24, after trying uploads on staging: creating categories meant leaving the item (and losing unsaved edits). Fixed: "+ New category" inside the item editor creates the category, ticks it and saves without a reload; admin pages now warn before leaving with unsaved changes.
- 2026-11-24: upload progress said "Uploading 1 of 7" (unclear). Now each step and file is named, and an error says where it stopped.
- 2026-11-24: moving a photo, saving one section or publishing reloaded the page, which hit the unsaved-changes warning when another section had edits (and left stale "Make cover" buttons). Now every reload or exit first saves all edited sections; the editor has a save bar (what is unsaved, Save, Save and close); Publish returns to the item list with a link to the public page; the cover photo has a badge.
- 2026-11-24, public site: browsing started from thumbnail grids, so the carousel and feed were easy to miss; categories were awkward to reach. Now lists (category pages, all items) open as the vertical feed with a Feed | Grid switch in the URL (search defaults to Grid; home keeps its overview plus "Scroll through everything"); a Collections index in the header; subcategories as compact buttons; clearer photo arrows; previous/next item as a small ▲ n / N ▼ pill. Category search/filters, more layouts and sorts stay in M3 (PUB-02/03).

### Owner tasks for M1

Claude gives click-by-click steps when each is needed.

- [x] O-05 (done 2026-11-25): Backblaze B2 account (steps: `docs/runbooks/backup-setup.md` parts A1 to A3, then B):
  - TOTP 2FA, SMS fallback off, backup codes offline;
  - two staging buckets with Object Lock and encryption;
  - job key (write-and-lock, no delete), read-only verify key, break-glass key kept offline.
- [x] O-06 (part, moved to M1; done 2026-11-25): onboard the domain to Cloudflare Email Sending for backup alerts (D-58; Email Routing stays off). Steps: `docs/runbooks/backup-setup.md` part A4.
- [x] Exit test on iPhone (2026-11-25): photographed, published, seen publicly, made private and gone from the public site.

### Not in M1

- Tag rename/merge, filters, sorts and layouts (M3); desktop drag-and-drop for categories as an extra (M3 polish, D-50).
- Video (M4).
- Watermark and licensing (M5).
- Edge caching and the domain move (M7, D-45).

### Done (M0)

- **Repo scaffold**: npm workspaces: `apps/public` and `apps/admin` (Astro 7, SSR on Workers), and `packages/core` (shared config, headers, errors, Access validation, Drizzle schema, public data-access layer). TypeScript strict (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Bindings** (ARC-03): public → `DB`, `MEDIA_PUBLIC`; admin → `DB`, `MEDIA_PUBLIC`, `MEDIA_PRIVATE`. Local and staging environments in each `wrangler.jsonc`. `preview_urls: false` everywhere; production `workers_dev: false`.
- **Drizzle + D1**: `settings` table, migration `0000_init.sql`, `db:generate` / `db:migrate:*` scripts. CI applies staging migrations before deploy (OPS-03).
- **Security headers** (SEC-07): one shared policy applied by both Workers and via the generated `_headers` for public static assets. Admin adds Trusted Types and `no-store`. Non-production and admin get `noindex`.
- **Admin auth** (SEC-03): every request, including static assets, passes Access JWT validation (RS256, JWKS, iss/aud/exp, owner email) and fails closed. CSRF check on writes (SEC-04).
- **Public pipeline**: GET/HEAD only, strips any `Set-Cookie`, generic errors.
- **Tests**:
  - 80 Workers-runtime unit tests: TST-03 forged-token matrix, CSRF, config, headers, public DAL.
  - 22 Playwright e2e tests × 3 browsers (Chromium, desktop WebKit, iPhone WebKit): TST-03 against the built admin, TST-04 on every public route type, axe, no cookies/storage/third-party requests, no CSP violations.
- **Guards**:
  - ESLint import boundary (public code → only `@cg/core/public|config|headers|errors`).
  - `npm run check:bundle`: the public bundle has no admin code, the dev bypass isn't shipped, and there are no inline scripts.
- **CI** (`.github/workflows/ci.yml`):
  - Lint, typecheck, unit tests, build, bundle check, `npm audit`, e2e, gitleaks.
  - Staging deploy + smoke test + ZAP baseline. These are gated on the `STAGING_ENABLED` repository variable until Cloudflare is set up.
  - CodeQL workflow. Dependabot (npm + Actions, 7-day cooldown).
- **Docs**: threat model, ASVS 5.0 L2 checklist skeleton, token register, Access runbook; decisions D-20 to D-37 added to §13.
- **Staging resources** (created 2026-11-13): D1 `cg-staging` (migrated to `0000_init`), R2 `cg-media-public-staging` and `cg-media-private-staging`. Workers `cg-public-staging` and `cg-admin-staging` are deployed with `workers_dev` off (no public URL; both return 404).
- **CI is green** on `main` (lint, typecheck, unit, build, e2e, gitleaks, CodeQL).

### Resume point (where we paused)

Owner: Access setup per `docs/runbooks/access-setup.md` — done 2026-11-22.

- [x] R2 enabled; `workers.dev` subdomain chosen (kept out of the repo, D-37)
- [x] `wrangler login` on the owner's machine
- [x] Both staging Workers protected with Worker-level Access, all traffic
- [x] **A.** Team-wide login methods: delete One-time PIN. Keep the team-wide Cloudflare method; just don't allow it on the apps.
- [x] **B.** On each staging app: login methods = GitHub only, Instant Auth on, session 24 h; replace the default "Cloudflare account" policy with Allow → Emails → owner's GitHub primary email; copy the **admin** app's AUD tag.
- [x] **C.** Service token `ci-staging` (1 year) and a Service Auth policy on the **public** app only.
- [x] **D.** `npx.cmd wrangler secret put ADMIN_EMAIL --name cg-admin-staging`
- [x] **E.** Cloudflare API token (account-owned `ci-staging-deploy`): Workers Scripts Edit + D1 Edit, expires 2027-11-22.
- [x] **F.** GitHub environment `staging` (deployment branches: `main` only), with secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
- [x] **G.** Team domain and admin AUD collected (the AUD was read from Access's login redirect: the dashboard didn't show it for Worker-level Access apps).

Then Claude:

1. [x] Staging values stored as GitHub `staging` **secrets** (not variables: Actions logs are public, D-37), with log masking in the workflow.
2. [x] `env.staging.workers_dev: true` in both configs. Both `workers.dev` URLs verified to redirect signed-out visitors to Access (2026-11-22).
3. [x] Push, `STAGING_ENABLED=true`, first CI staging deploy. The first attempt (2026-11-22) found two bugs (see Incidents). After the fix, run 45098773201 was all green: the deploy was verified on `cg-public-staging` / `cg-admin-staging`, the smoke test passed, and the ZAP baseline had 0 FAIL, 65 PASS and 3 WARN (cache-control ×2 rules, COEP missing; triage in M1). No account values appear in the logs.
4. [x] Owner sign-in check (2026-11-22). The owner's GitHub login reaches the admin and public hello-world pages. Two things were found on the way:
   - The admin app still had Cloudflare's default "Cloudflare account members" policy instead of the owner's email (fixed; runbook updated).
   - GitHub's passkey step 404s in the owner's private browser window. That's a GitHub/browser issue (nothing reached our Workers); a normal window works.
5. [x] Branch protection (2026-11-22): repository ruleset `main` (D-38). Squash merges only; branches deleted after merge.
6. [x] M0 review summary (below).

### M0 review summary

**Built:** everything listed under "Done (M0)": the two-Worker scaffold, the shared core, Access JWT validation, security headers, tests and CI/CD.

**Exit criteria:** all met:

- hello-world public and admin pages on staging, behind Access;
- TST-03 and TST-04 pass locally, in CI and against real staging;
- CI is green, including the staging deploy, smoke test and ZAP baseline (0 FAIL).

**Deviations:** D-20 to D-38 in §13. The notable ones are:

- staging on `workers.dev` (D-21);
- account-identifying values kept out of the repo and out of the public logs (D-37);
- `npm audit` instead of OSV-Scanner (D-36);
- PRs with 0 required approvals (D-38).

**Incident:** the 2026-11-22 wrong-Worker deploy (below), now prevented by a guard and a post-deploy check.

**Owner follow-ups:**

- review this summary;
- renew the CI tokens before 2027-11-22;
- triage the 3 open Dependabot PRs (they now merge through the PR workflow);
- ~~register the domain before M1 ends~~ **done 2026-11-22** (O-04).
  - Registered with Cloudflare Registrar.
  - Verified from outside: DNSSEC active (DS published); CAA allows Let's Encrypt, Google Trust Services and SSL.com (plus Cloudflare's auto-added backup CAs); SPF `-all` and DMARC `p=reject` (no mail sent yet; M5 revisits).
  - Registrar lock and auto-renew checked by the owner.
  - The domain goes into config/env as `{{DOMAIN}}` when staging moves to it (first step of M1).

**Carried into M1:** ZAP warnings (cache-control ×2, COEP); a token-expiry warning in CI; `backup:verify` (BAK-08).

### M0 exit criteria

| Criterion                                       | State                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Hello-world public + admin on staging           | ✅ CI-deployed behind Access; owner sign-in verified (2026-11-22) |
| Admin rejects unauthenticated requests (TST-03) | ✅ locally + CI + staging smoke test                              |
| Headers test passes (TST-04)                    | ✅ locally + CI + staging smoke test                              |
| CI green                                        | ✅ (2026-11-22, incl. staging deploy + ZAP)                       |

### Security review (2026-11-22, after M0)

Two independent reviews (application code; CI, supply chain and GitHub settings) plus live checks of Cloudflare, DNS and the owner's dashboards. Nothing was exploitable; staging was fully behind Access throughout. Fixes:

- **GitHub settings** (D-40): secret scanning and push protection, private vulnerability reporting (the README already promised it), Dependabot security updates, Actions allowlist with SHA pinning, approval for all outside contributors' workflow runs, no admin bypass on `staging`.
- **Deploy integrity:** the deploy job bundle-checks the exact staging build; `deploy-staging.ts` re-runs the bundle check and verifies the public `_headers` is the staging policy; builds refuse a non-production `NODE_ENV`.
- **Dev-only behaviour confined** (D-41): the admin bypass and the public Report-Only CSP also require a loopback host. Top-level Wrangler configs renamed `cg-<app>-local`.
- **Secrets in CI:** the Cloudflare token reaches only the migrate and deploy steps. The ZAP report is published only if redaction succeeds and now also redacts the admin host and team domain. The service-token headers are scoped to the staging host, and the scan fails if it didn't get past Access. Wrangler telemetry off.
- **Admin:** rejects Access tokens older than 24 h (SEC-02) and non-application tokens; strips any app `Set-Cookie` (SEC-08).
- **Tests:** smoke now checks a static asset's headers, that `/_headers` isn't served, and an exact 405. E2E expects an exact 405 and checks `/_headers`. Unit tests 72 → 80.
- **Recorded:** D-39 (separate production credentials by M7), D-37 is defence in depth only.
- **Owner checks:** one service token, Access policies and login methods correct, no other apps, Workers, members or stray API tokens.

### Recurring maintenance

- Quarterly: update the pinned ZAP image digest in `ci.yml` (Dependabot can't), and check the gitleaks version gitleaks-action downloads.
- Before 2027-11-22: renew `ci-staging-deploy` and the `ci-staging` service token (`docs/security/tokens.md`).
- During long breaks: `npx.cmd wrangler logout` on the owner's machine.
- Quarterly (automatic): restore drill, 2 Jan/Apr/Jul/Oct (`restore-drill.yml`); weekly (automatic): `backup:verify`. GitHub emails on failure; record each drill in `docs/runbooks/restore-drill.md`.

### Incidents

- **2026-11-22: first CI staging deploy went to the wrong Workers.** The deploy job's `CLOUDFLARE_ENV=staging` reached `wrangler deploy` on the already-flattened staging config. Wrangler then appended a second `-staging`, creating new Workers `cg-public-staging-staging` and `cg-admin-staging-staging` on `workers.dev` without Access.
  - The public one served the placeholder hello-world page to anyone for about 4 minutes. No private data existed.
  - The admin one failed closed (500: no `ADMIN_EMAIL`).
  - Both were deleted, and `STAGING_ENABLED` was set to false.
  - The smoke test passed only because it hit the real (old) Workers.
  - **Fixes:** `scripts/deploy-staging.ts` now refuses unless the build is the staging config for `cg-<app>-staging`, strips `CLOUDFLARE_ENV`, passes `--name` explicitly, and then verifies (via a per-deploy message) that the expected Worker is running this deploy.
  - Also: Access doesn't issue a session cookie to service tokens, so the ZAP job now sends the service-token headers via ZAP replacer rules.

- **2026-11-22: ZAP report possibly published unredacted.** The first version of the ZAP step redacted `report.md` in place with errors ignored (`|| true`), but ZAP writes the file as its container user, so the redaction almost certainly failed. Runs 45098773201 and 45104646227 then appended the report to their public job summaries.
  - Those scans were fully authenticated, so the report lists alert names and public-staging URLs. The worst case is the staging public hostname (behind Access, and already inferable, see D-37). ZAP's summary report has no request headers, so no token.
  - The hardened version (PR #6) withheld the report and failed instead, which is how this was found.
  - **Fix:** `redact.py` now writes the redacted text to a new file and never edits ZAP's.
  - Owner decision: delete those two runs' records.

### Deviations from the spec

All are recorded in `docs/REQUIREMENTS.md` §13 as D-20 to D-37. The main ones:

- Staging runs on `workers.dev` until the domain exists (D-21).
- Staging serves media from the public host (D-25).
- `ADMIN_EMAIL` is split from the contact-form address (D-28).
- `npm audit` is used instead of OSV-Scanner (D-36).
- Photo files are verified as each one arrives, before storage, rather than only at finalize (stricter; D-51). Removing a single photo is soft with a 30-day restore (D-51).
- Search is rate-limited with one shared key per location instead of per visitor (D-53). Categories without public items are hidden (D-54).
- Backup alerts use Cloudflare Email Sending instead of Email Routing (D-58). The first alert arrived about two hours after the run, so the weekly `backup:verify` stays the check of record.

### Known advisories (accepted, dev-only, below the high/critical CI gate)

- `esbuild <=0.24.2` (moderate, GHSA-67mh-4wv8-2f99): pulled in by `drizzle-kit`'s `@esbuild-kit/*`. It affects esbuild's dev server, which we never run. Re-check when drizzle-kit drops `@esbuild-kit`.
- ~~`minimatch`~~ resolved 2026-11-22 by Dependabot PRs #7 and #11 (minimatch 11).

**Dependency updates merged 2026-11-22** (each verified on staging: deploy, smoke, ZAP 0 FAIL): jose 6.2.17 (#3); astro 7.4.12, @astrojs/cloudflare 14.4.8, wrangler 4.162.0, @cloudflare/vitest-plugin 1.8.2, workers-types (#8); @types/node 26 (matches the Node 26 runtime), Playwright 1.65.1, eslint 10.15, prettier 3.10.1 (#7); typescript-eslint 8.73.0 (#11). `npm audit`: only the 4 moderate esbuild/drizzle-kit findings above remain.

### Dependencies (exact-pinned; one-line justification each)

| Package                                                                             | Where                                                                | Why                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro`                                                                             | apps                                                                 | Settled framework (D-02)                                                                                                                                                                             |
| `@astrojs/cloudflare`                                                               | apps                                                                 | Official Workers adapter for Astro                                                                                                                                                                   |
| `@cg/core`                                                                          | apps                                                                 | Internal shared package (ARC-02)                                                                                                                                                                     |
| `zod`                                                                               | core                                                                 | Validation at trust boundaries (SEC-05, settled stack)                                                                                                                                               |
| `jose`                                                                              | core                                                                 | Standard, dependency-free JWT/JWKS verification for SEC-03 (Web Crypto, works in Workers)                                                                                                            |
| `drizzle-orm`                                                                       | core                                                                 | Settled ORM, parameterised queries                                                                                                                                                                   |
| `drizzle-kit` (dev)                                                                 | core                                                                 | Generates forward-only SQL migrations (OPS-03). Its transitive `@esbuild-kit/*` deps are old but dev-only, never shipped                                                                             |
| `wrangler` (dev)                                                                    | root, apps                                                           | Cloudflare CLI: dev, deploy, D1 migrations, types                                                                                                                                                    |
| `typescript` (dev)                                                                  | root, apps                                                           | Strict typing; held at 6.0 for tool compatibility (D-33)                                                                                                                                             |
| `@astrojs/check` (dev)                                                              | apps                                                                 | Typechecks `.astro` files                                                                                                                                                                            |
| `vitest` (dev)                                                                      | core                                                                 | Unit/integration tests (TST-01)                                                                                                                                                                      |
| `@cloudflare/vitest-plugin` (dev)                                                   | core                                                                 | Runs tests inside workerd (TST-01, D-34)                                                                                                                                                             |
| `@cloudflare/workers-types` (dev)                                                   | core, apps                                                           | Workers runtime types                                                                                                                                                                                |
| `@playwright/test` (dev)                                                            | root                                                                 | E2E across Chromium + WebKit (TST-01)                                                                                                                                                                |
| `@axe-core/playwright` (dev)                                                        | root                                                                 | Accessibility checks in CI (NFR-03)                                                                                                                                                                  |
| `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-astro`, `globals` (dev) | root                                                                 | Linting incl. the INV-1 import boundary                                                                                                                                                              |
| `prettier`, `prettier-plugin-astro` (dev)                                           | root                                                                 | Formatting                                                                                                                                                                                           |
| `@types/node` (dev)                                                                 | root                                                                 | Types for build/test scripts                                                                                                                                                                         |
| `@jsquash/webp`                                                                     | admin (browser only)                                                 | WebP encoding on the device (D-44): Safari can't encode WebP from a canvas. libwebp compiled to WASM, Apache-2.0, widely used; brings `wasm-feature-detect` (SIMD check). Never in the public bundle |
| `ghcr.io/google/osv-scanner` (container image)                                      | CI                                                                   | Weekly dependency scan against OSV (D-67). Google's official OSV-Scanner, Apache-2.0, pinned by digest (v2.7.1); run like the ZAP image, so no new Action is allowed                                 |
| `fflate` (planned, M2)                                                              | admin (browser: read the export zip; Worker: stream the archive zip) | Zip reading and writing (D-72). MIT, no dependencies, small, widely used                                                                                                                             |
| `mediabunny`                                                                        | admin (browser only)                                                 | Video reading, conversion to H.264 + AAC MP4, trimming and poster frames with WebCodecs (D-61). MPL-2.0, zero dependencies, ~8 M weekly downloads.                                                   |
