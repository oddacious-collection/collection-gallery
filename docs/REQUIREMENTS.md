# Collection Gallery — Requirements Specification

Version 1.0 · 2026-11-14 · Owner: {{OWNER_NAME}} · Status: **Approved for build**

---

## 0. How to read this document

- **MUST / MUST NOT / SHOULD / MAY** follow RFC 2119.
- Every requirement has a stable ID (e.g. `PUB-05`). Reference IDs in commits, tests and `PROGRESS.md`.
- `AC:` lines are acceptance criteria. Make them automated tests wherever feasible.
- **[PUBLIC]** means anyone browsing can see it. **[ADMIN]** means only the owner sees it, in the admin app.
- Placeholders: `{{OWNER_NAME}}`, `{{DOMAIN}}` (not chosen yet, must be configurable), `{{OWNER_EMAIL}}` (the only identity allowed into admin; set via config, never committed).
- §16 lists defaults that were chosen without explicit owner input. The owner may change them.

---

## 1. Overview

### 1.1 Purpose
A fast, inexpensive, secure public website showing the owner's personal collections: many unrelated collections, each a hierarchy of categories. Visitors browse photos and short videos of objects. The owner manages everything, including private financial and provenance data, from an admin app on desktop or phone.

### 1.2 Users
| Role | Description |
|---|---|
| Visitor | Anonymous, no account. Browses, searches, likes, and requests permission to use photos. |
| Owner | The only admin. Authenticates via Cloudflare Access with a passkey. |

### 1.3 Goals
1. A beautiful, fast gallery that works great on phones (an Instagram-like feed) and desktops.
2. Rich private record-keeping (price, value, provenance, documents), never exposed publicly.
3. Privacy-respecting: no cookies, no consent banner, no tracking.
4. Able to withstand a professional pen test and security audit.
5. Run cost of about $0–5/month plus the domain.

### 1.4 Non-goals (do NOT build)
- Visitor accounts, comments, discussion board (future; see §11.3 design hooks).
- Marketplace, sales or trade listings (a private "open to parting with" flag is the only exception).
- Installable app / PWA, service worker, install prompts.
- Right-click or long-press blocking.
- Multiple owners or admins.
- Sorting or filtering by value or condition on the public site.

---

## 2. Invariants (apply to every requirement)

| ID | Invariant |
|---|---|
| INV-1 | **Private never leaks.** Server-side exclusion only. Public queries go through a single public data-access layer that selects public fields from public items only. Admin-only data has no path to public responses. |
| INV-2 | **Nothing lost by accident.** Soft delete, revision history, versioned off-site backups. |
| INV-3 | **Privacy by default.** No cookies, no browser storage, no third-party requests on public/media hosts (except Turnstile on `/contact`). No raw IP storage. |
| INV-4 | **Secure by default.** OWASP ASVS L2, strict CSP, least privilege everywhere. |
| INV-5 | **Owner-only content.** No visitor-generated content is ever displayed on the site. |
| INV-6 | **Cheap.** Free tiers + Workers Paid. Flag before exceeding. |

---

## 3. Architecture

### 3.1 Hostnames
| Host | Serves | Access |
|---|---|---|
| `{{DOMAIN}}` (apex; `www` redirects to apex) | Public site (Worker: `public`) | Anonymous |
| `admin.{{DOMAIN}}` | Admin app (Worker: `admin`) | Cloudflare Access, owner only |
| `media.{{DOMAIN}}` | Images/video (served by the `public` Worker or a dedicated `media` Worker) | Anonymous, public items only |
| `staging.{{DOMAIN}}`, `admin.staging.{{DOMAIN}}` | Staging copies | **All** behind Access (staging must not be indexed or public). Until the domain exists: `*.workers.dev` (D-21); staging media served from the staging public host (D-25); see D-26 for the admin name |

- ARC-01: Public and admin MUST be **separately deployed Workers**. The public Worker's code MUST contain no admin routes or write paths other than likes, view beacons and the contact form.
- ARC-02: A shared internal package holds the schema, types and validation. Public code imports only the public data-access layer.
- ARC-03: Cloudflare bindings: D1 (`DB`), R2 buckets `media-public` (derivatives), `media-private` (originals, documents, captions source), the `send_email` binding, rate-limit bindings, secrets.

### 3.2 Stack (settled; see §13)
Astro (SSR on Workers via the official Cloudflare adapter; interactive islands only where needed) · TypeScript strict · Drizzle ORM + D1 · Zod · R2 · Cloudflare Access · Turnstile · Cloudflare Email · Backblaze B2 · Vitest · Playwright · axe-core · GitHub Actions.

### 3.3 Uploads
- ARC-04: Media is processed **in the admin's browser** (§5.2), then uploaded **directly to R2 via short-lived presigned URLs** issued by the admin Worker. A finalize call makes the server verify the object (type, size, dimensions or duration) before attaching it to an item.

---

## 4. Data model

IDs are ULIDs. Money is stored as integer cents plus an ISO 4217 currency (default USD). All timestamps are UTC ISO-8601.

### 4.1 Item
| Field | Type | Visibility | Notes |
|---|---|---|---|
| id, slug | ulid, string | PUBLIC (slug) | Slug is unique, editable, with old slugs redirected (301) |
| kind | `owned` \| `wishlist` | ADMIN | Wishlist items can NEVER be public |
| status | `draft` \| `public` \| `private` | ADMIN | Only `public` + `owned` + not trashed is visible |
| title | text | PUBLIC | required |
| description | restricted Markdown | PUBLIC | no raw HTML (SEC-06) |
| posted_at | datetime | PUBLIC | Auto-set on first publish, editable |
| categories | many-to-many | PUBLIC | ≥1 required to publish |
| tags | many-to-many | PUBLIC | |
| media | ordered list | PUBLIC (if item public) | ≥1 required to publish; one is the cover |
| custom field values | per definition | per field definition | §4.4 |
| license_override | nullable enum | PUBLIC (effective license) | §5.6 |
| watermark_override | `inherit` \| `on` \| `off` | ADMIN | |
| purchase_price, purchase_currency | int, char(3) | ADMIN | |
| purchase_date | date | ADMIN | |
| open_to_parting | bool | ADMIN | |
| provenance | see 4.5 | ADMIN | |
| valuations | see 4.5 | ADMIN | value history |
| created_at, updated_at, deleted_at | datetime | ADMIN | deleted_at = in trash |

### 4.2 Media
| Field | Notes |
|---|---|
| id, item_id, position, is_cover | |
| kind | `image` \| `video` |
| original_key | in `media-private`; unguessable (≥128-bit random) |
| variants | JSON: list of {key, width, height, format, watermarked} in `media-public`, unguessable keys |
| width, height, duration_s, has_audio | |
| poster_key | video poster frame |
| captions_key | optional WebVTT |
| alt_text | PUBLIC; falls back to item title if blank (ADM-03) |
| created_at, deleted_at | |

### 4.3 Category (tree)
- `id, parent_id (nullable), name, slug, description, position, cover_media_id, default_license (nullable)`.
- CNT-01: **Exactly one parent** (or none, for top level). Unlimited depth. Cycles MUST be prevented.
  AC: moving a category under its own descendant is rejected.
- CNT-02: Items belong to **any number of categories at any depth**. An item in a category appears in all of that category's ancestors' listings.
  Example: an item in `Rocks & Minerals › Meteorites › Chondrites › H` appears when browsing Chondrites, Meteorites and Rocks & Minerals.
- CNT-03: Implement with an adjacency list plus a closure table (or materialized path) for efficient descendant queries.

### 4.4 Custom fields
- `field_definitions`: `id, category_id, key, label, type (text|long_text|number|date|bool|select|url), options, visibility (public|admin), position`.
- CNT-04: A definition on a category applies to items in that category **and all descendant categories** (templates inherit down the tree). Items in several categories get the union of applicable fields.
- CNT-05: Each field's visibility is PUBLIC or ADMIN. ADMIN field values follow INV-1.
- `item_field_values`: `item_id, field_id, value`.

### 4.5 Collector records [ADMIN]
- `valuations`: `item_id, date, value_cents, currency, source, note` (history; the latest is the current estimated value).
- `provenance_events`: `item_id, date, type (acquired|gifted|appraised|restored|exhibited|other), counterparty, description`.
- `documents`: `item_id, provenance_event_id (nullable), key (media-private), filename, mime, size` (receipts, certificates, PDFs).
- `permission_grants`: `id, requester_name, requester_email, item_id, media_id (nullable), intended_use, credit_line, granted_on, terms, notes`.
- `permission_requests`: inbound form submissions (§5.7), auto-deleted after 180 days unless linked to a grant.

### 4.6 System tables
- `tags` (id, name, slug) + `item_tags`.
- `item_revisions`: `id, item_id, snapshot (JSON), created_at`, written on every save.
- `audit_log`: `id, at, actor_email, action, target_type, target_id, details`.
- `analytics_daily`: `date, item_id (nullable for site-level), metric (view|like), country, region, referrer_host, count`.
- `like_dedupe`: `date, item_id, hash` (purged after 48 h).
- `settings`: owner_name, default_license, watermark_enabled, watermark_text, like_count_public, contact_enabled, etc.
- `slug_redirects`.

---

## 5. Functional requirements

### 5.1 Content management [ADMIN]
| ID | Requirement |
|---|---|
| ADM-01 | Admin app at `admin.{{DOMAIN}}`, fully responsive, usable on an iPhone in Safari for photographing and uploading items. |
| ADM-02 | Create, edit, save draft, publish, unpublish items. A **Public/Private toggle** is prominent on the item editor and in list views. |
| ADM-03 | Upload multiple photos/videos per item; drag to reorder; set cover; per-media alt text (falls back to item title if blank). A "Missing alt text" report lists offenders. |
| ADM-04 | **Trash**: deleting moves to trash (disappears publicly at once). Restore within 30 days; auto-purge after 30 days; "Delete permanently" purges at once (live storage only; backups expire per §9). Applies to items and individual media. |
| ADM-05 | **Revision history** per item: list revisions, view diff, restore a revision. |
| ADM-06 | Category tree manager: create, rename, edit, drag to reorder or move (cycle-safe), delete (only when empty, or after reassigning its items). |
| ADM-07 | Tag manager: rename, merge, delete. |
| ADM-08 | Custom field definitions per category (CNT-04/05). |
| ADM-09 | **Bulk actions** on multi-selection: add/remove tags, add/remove categories, set status, set watermark/license override, trash. |
| ADM-10 | Admin item list: search, filter and sort by **everything**, including admin fields (value, purchase date, open_to_parting, wishlist, status, missing alt text). |
| ADM-11 | **Wishlist** section: items with `kind=wishlist`; can be converted to `owned` once acquired. |
| ADM-12 | **Open to parting with** flag + filter. |
| ADM-13 | Collector records: valuations with history, provenance timeline, document attachments (§4.5). |
| ADM-14 | **ISBN lookup**: enter an ISBN → fetch from the Open Library API → prefill title, author(s), publisher, year and ISBN as custom fields. Barcode scanning via the camera MAY be offered where the browser supports it. Cover images from Open Library MUST NOT be auto-added as item media (third-party copyright). |
| ADM-15 | Settings page (watermark, default license, owner name, like-count visibility, contact form on/off, etc.). |
| ADM-16 | Audit log viewer. |
| ADM-17 | Permission requests inbox + grants log (§4.5). |
| ADM-18 | Before publishing, show a reminder checklist: alt text, no visible personal info (faces, addresses, receipts) in photos. Not blocking. |

AC (ADM-02/04): toggling an item to private, or trashing it, removes it from **every** public surface within 60 s, including the CDN cache (see MED-10, TST-2).

### 5.2 Media pipeline
| ID | Requirement |
|---|---|
| MED-01 | Accepted inputs. Images: JPEG, PNG, WebP, AVIF, HEIC/HEIF. Video: MP4, MOV (H.264 or HEVC). **Rejected**: everything else, explicitly including SVG, GIF, HTML, PDF-as-media. |
| MED-02 | **Client-side processing** in the admin browser before upload: decode → apply EXIF orientation → **strip all metadata** (GPS especially) → re-encode. HEIC must work on iPhone Safari; on browsers that can't decode HEIC, use a well-maintained WASM decoder or show a clear error. |
| MED-03 | **Server verification** on finalize: magic-byte type check, max size (images 30 MB original, video 100 MB original), dimensions/duration limits; reject on any mismatch. |
| MED-04 | **Originals** are stored as uploaded in `media-private` (never public; admin-download only, served as `Content-Disposition: attachment`). They're used to regenerate derivatives. |
| MED-05 | **Public image derivatives** in `media-public`: long-edge widths 400, 800, 1200, 1600, **2048 max**; WebP; plus one JPEG 1200 px for Open Graph. Served with `srcset`/`sizes` and explicit width/height. **Originals are never served publicly.** |
| MED-06 | **Watermark**: small, semi-transparent text (setting `watermark_text`, default `© {{OWNER_NAME}} · {{DOMAIN}}`) in the bottom-right corner, burned into derivatives ≥800 px and into video. A global setting plus per-item override. Changing the text or setting triggers regeneration of affected derivatives (admin-browser job with a progress UI). |
| MED-07 | **Embedded rights metadata**: after stripping, write back **only** creator/artist and copyright notice (EXIF and/or XMP) into public derivatives. Never GPS or camera serials. |
| MED-08 | **Video output**: ≤ **60 s** (reject longer; trimming MAY be offered), MP4 container, **H.264 video + AAC-LC audio**, ≤1080p, ~4–5 Mbps target, `faststart` (moov atom first), metadata stripped, watermark burned in, poster frame (owner-selectable, default first frame). Encoding happens in the browser via WebCodecs (or a well-maintained wrapper). Fallback if infeasible: Cloudflare Stream (requires owner approval, cost impact). |
| MED-09 | Per-video option **"Remove audio"**; output then has no audio track and the player shows no sound control. |
| MED-10 | **Media serving** on `media.{{DOMAIN}}`: unguessable keys; the Worker checks the parent item is publicly visible before serving (or the CDN cache is purged on visibility change); **HTTP Range** support (required for Safari video); correct `Content-Type`; `X-Content-Type-Options: nosniff`; long-lived immutable caching for public items. AC: a private, draft, wishlist or trashed item's media URL returns 404 within 60 s of the change, including from the CDN. |
| MED-11 | **Hotlink protection**: allow requests with no Referer, Referers from our own hosts, and known link-preview crawlers. Others get 403. The embed widget (PUB-13) is served from our host, so it keeps working. |
| MED-12 | Optional **WebVTT captions** per video, uploaded in admin. |
| MED-13 | Media keys are never reused; a replaced file gets a new key (immutability simplifies caching and backups). |

### 5.3 Public site [PUBLIC]
| ID | Requirement |
|---|---|
| PUB-01 | **Home**: hero/intro, top-level categories, recently posted items, a "Surprise me" button. |
| PUB-02 | **Gallery views** with three layouts: **grid, list, masonry**, switchable by the visitor. Layout choice lives in the URL query (no storage). Lazy-loaded images; no layout shift. |
| PUB-03 | **Filters**: category (including descendants), tags, posted-date range. **Sorts**: newest, oldest, title A→Z, title Z→A, category. No value or condition sort/filter. State lives in the URL (shareable). |
| PUB-04 | **Item page**: media carousel (left/right arrows, swipe, ←/→ keys, position dots, pinch/zoom on images, inline video), title, description, posted date, category breadcrumbs (all categories), tags, public custom fields, license badge + credit line (RGT-03), like button (ANL-03), "Request to use this photo" link (CON-01), share link. |
| PUB-05 | **Vertical feed (Instagram-style)**: from any list (category, search, filter, home), opening an item enters a feed. **Vertical** swipe/scroll/↑↓ moves between items in that list; **horizontal** moves between that item's media. The URL updates per item (`history.replaceState`) so it's shareable; the Back button returns to the originating list at the same scroll position. Prefetch the next 2 items. On-screen next/previous buttons too (accessibility). A direct load of an item URL uses the context "all public items, newest first". |
| PUB-06 | **Video playback** (feed and item page): autoplay **muted**, loop, `playsinline`; only the on-screen video plays; pause when off-screen. **Sound preference persists for the visit only**: once the visitor unmutes, subsequent videos play with sound until they mute again. Kept in page memory only, so a reload starts muted. On iOS Safari, keep sound working across items by reusing a pool of player elements unlocked by the unmute tap. If the browser still blocks sound, play muted and show a clear one-tap unmute. |
| PUB-07 | **Category pages**: breadcrumbs, child categories, items (including descendants by default, toggleable), filters/sorts/layouts. |
| PUB-08 | **Search**: full-text over title, description, tag names, category names and **public** custom field values, across all categories by default, optionally scoped to one category + descendants. The search index MUST contain only public data from public items (D1 FTS5). |
| PUB-09 | **Surprise me / spin the wheel**: picks a random public item from the current scope (current category/search/filter, or everything). **No repeats** until the scope is exhausted: the client gets the scope's ID list, shuffles (Fisher–Yates) and walks it, in memory only. Short spin animation, skipped under `prefers-reduced-motion`. The result has a normal shareable item URL. |
| PUB-10 | **Shuffle mode** for the feed: vertical navigation walks the shuffled order from PUB-09. |
| PUB-11 | **Slideshow / exhibition mode**: full-screen, auto-advance (configurable 3–15 s), pause/play, keyboard controls; videos play to the end before advancing. |
| PUB-12 | **Static pages**: About the collector, Using my photos (RGT-05), Privacy (PRV-05), Contact/permission request (§5.7). Content is editable in admin (restricted Markdown). |
| PUB-13 | **Embed widget**: `/embed/item/{slug}` and `/embed/category/{slug}` are iframe-able pages (the only routes with a permissive `frame-ancestors`). They set no cookies, load no scripts beyond our own, and include attribution + a link back. Admin shows a copy-paste snippet. |
| PUB-14 | **Sharing/SEO**: Open Graph + Twitter card tags per item, category and page; canonical URLs; `sitemap.xml` (public only); semantic HTML; good titles/descriptions. |
| PUB-15 | **Not-found behavior**: draft, private, wishlist, trashed and nonexistent items all return an identical 404 (no existence leak). Old slugs 301 to the current slug (only if the item is public). |
| PUB-16 | **No install prompts**: no web app manifest install behavior, no service worker. |

### 5.4 Import / export [ADMIN]
| ID | Requirement |
|---|---|
| IMP-01 | **Instagram import**. The owner downloads their data from Meta Accounts Center ("Download your information", **JSON** format) and uploads the zip in admin. Processing happens **in the browser**: parse posts → for each post create a **Draft** item (caption → description, hashtags → tags, timestamp → posted_at, carousel media → item media, run through the full MED pipeline including metadata stripping and the 60 s video limit). |
| IMP-02 | The Instagram importer MUST import **only the owner's own post content**. Discard other people's comments, DMs, followers/following, likes and profile data. |
| IMP-03 | Import is **idempotent**: re-importing the same export creates no duplicates (keyed on the Instagram post ID/timestamp + media hash). |
| IMP-04 | **Review queue** for imported drafts: quick-edit title, assign categories, bulk publish. |
| IMP-05 | The importer must tolerate export format variations (Meta changes the folder layout over time). Fail per post with a clear report, never all-or-nothing. Develop against a real export (owner task O-08). |
| IMP-06 | **CSV/JSON export** of items (all fields, including admin) and **CSV/JSON import** (create/update by ID or slug, with a dry-run preview). |
| IMP-07 | **Full archive export**: a zip of the DB export (JSON) + all originals + documents + captions, generated on demand. |

### 5.5 Analytics & engagement
| ID | Requirement |
|---|---|
| ANL-01 | **Views**: a first-party beacon (`navigator.sendBeacon`, no cookies, no identifiers) when an item is displayed ≥1 s (item page or feed). Ignore obvious bots (user-agent heuristics; JS-only beacon). Aggregate into `analytics_daily`. |
| ANL-02 | **Geography**: from Cloudflare's request metadata (`request.cf.country`, `request.cf.region`). **Country + region only**; no city, no coordinates, no IP. Aggregated daily counts only. |
| ANL-03 | **Likes**: one like per visitor per item per day. Dedupe with `HMAC(daily_secret, ip + item_id)` stored in `like_dedupe` ≤48 h. `daily_secret` rotates every 24 h and old secrets are destroyed. The server can answer "already liked today" so the button shows its state with no client storage. Rate limited. Like **count is shown only in admin by default** (setting `like_count_public`). |
| ANL-04 | **Referrers**: store the referrer **host** only, aggregated. |
| ANL-05 | **Dashboard** [ADMIN], with date-range selection: total items, items per category (including descendants), total and per-category purchase cost and current estimated value, value over time (from valuations), views and likes per item and site-wide, top items, countries/regions (table + simple map), top referrers, recently added. |
| ANL-06 | Do **not** use the Cloudflare Web Analytics JS beacon (third-party script). Site-level traffic is also visible in the Cloudflare dashboard's server-side zone analytics. |

### 5.6 Rights & attribution
| ID | Requirement |
|---|---|
| RGT-01 | Site-wide default license: **CC BY-NC 4.0** (setting). |
| RGT-02 | License resolution: item `license_override` > category `default_license` (inherited down the tree) > site default. If an item's categories disagree, the **most restrictive** wins (All Rights Reserved > BY-NC-ND > BY-NC-SA > BY-NC > BY). Seed the "Books" category (and any category whose items depict third-party artwork) with **All Rights Reserved**. |
| RGT-03 | Item page shows the license badge + link and the credit line "Photo © {year} {{OWNER_NAME}}". The site footer shows "© {current year} {{OWNER_NAME}}. Photos licensed CC BY-NC 4.0 unless otherwise noted." |
| RGT-04 | Machine-readable: `rel="license"` links, plus schema.org `ImageObject` JSON-LD with `license`, `acquireLicensePage` (→ the permission form), `creditText`, `creator`, `copyrightNotice` (enables the Google Images "Licensable" badge). |
| RGT-05 | "Using my photos" page (owner-editable). Default text: free for non-commercial use with credit in the format "Photo: {{OWNER_NAME}} / {{DOMAIN}}" under the license; for commercial or other use, ask; the owner reserves the right to decline; don't imply endorsement. Also note that CC 4.0 lets the licensor ask for their name to be removed from adaptations. |
| RGT-06 | `robots.txt` disallows known AI training crawlers; enabling Cloudflare's AI-bot blocking is owner task O-06. |
| RGT-07 | No right-click/drag/long-press blocking (explicit non-goal). |

### 5.7 Contact / permission requests
| ID | Requirement |
|---|---|
| CON-01 | `/contact` form, linked as "Request to use this photo" from each item (pre-filled `?item={slug}`), plus a general contact link. Can be disabled in settings. |
| CON-02 | Fields: name, email, item (pre-filled), intended use, where it will appear, proposed credit line, message. Strict max lengths. |
| CON-03 | Spam controls: **Turnstile** (verified server-side), hidden honeypot field, minimum time-to-submit, rate limits (e.g. 3/hour per IP-hash, 30/day global). |
| CON-04 | Content safety: plain text only; URLs defanged in the email body (`hxxps://example[.]com`); no attachments; strip CR/LF from header-bound fields (prevents header injection). |
| CON-05 | Delivery via Cloudflare's `send_email` binding to the owner's verified address, with `Reply-To` set to the requester. **No auto-reply or copy to the sender.** |
| CON-06 | Submissions are never displayed publicly. Stored in the admin inbox (ADM-17) and auto-deleted after 180 days unless linked to a grant. |
| CON-07 | Turnstile's script loads **only** on `/contact`. That page's CSP allows exactly the Turnstile origin. |

---

## 6. Security (target: OWASP ASVS 5.0 Level 2)

| ID | Requirement |
|---|---|
| SEC-01 | Maintain `docs/security/asvs-checklist.md` mapping each applicable ASVS L2 control to implementation and test. Write a STRIDE threat model (`docs/security/threat-model.md`) in M0 and update it each milestone. |
| SEC-02 | **Admin authentication**: Cloudflare Access application on `admin.*` (and all staging hosts). Policy allows only `{{OWNER_EMAIL}}`. The identity provider MUST enforce passkeys/MFA. The Access one-time-PIN login method MUST be disabled. Session ≤24 h. |
| SEC-03 | **Defense in depth**: the admin Worker validates the `Cf-Access-Jwt-Assertion` on **every** request (signature against the team JWKS, `aud`, `iss`, `exp`, email == owner). It fails closed. AC: requests with a missing, expired, wrong-aud or wrong-email token get 403. |
| SEC-04 | **CSRF**: state-changing admin requests use non-GET methods and require a matching `Origin` header (plus a custom request header). |
| SEC-05 | **Validation**: Zod schemas at every trust boundary (requests, form posts, imports, env/config). Parameterized queries only (Drizzle). |
| SEC-06 | **Output safety**: auto-escaping templates; restricted Markdown (paragraphs, emphasis, lists, links, headings) rendered with an allowlist sanitizer; no raw HTML; links get `rel="noopener noreferrer"`; no open redirects. |
| SEC-07 | **Headers** (all hosts): strict **CSP** (`default-src 'none'`, then explicitly allow `'self'` for needed directives; scripts via `'self'` + hashes/nonces; **no** `'unsafe-inline'`/`'unsafe-eval'`; `object-src 'none'`; `base-uri 'none'`; `form-action 'self'`; `frame-ancestors 'none'` except embed routes); **HSTS** `max-age=63072000; includeSubDomains` (add `preload` + submit at launch, M7); `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` denying unused features; `Cross-Origin-Opener-Policy: same-origin`; appropriate `Cross-Origin-Resource-Policy`. Trusted Types SHOULD be enabled on admin. |
| SEC-08 | **Cookies**: the public and media hosts set none. Admin: only Access's cookie, scoped to the admin host (never the parent domain). |
| SEC-09 | **Secrets & tokens**: Workers secrets only; `.dev.vars` git-ignored; secret scanning in CI (gitleaks or GitHub secret scanning). Every API token is least-privilege and documented in `docs/security/tokens.md` (purpose, scope, rotation). Backup keys can write but **not delete** (BAK-05). |
| SEC-10 | **Supply chain**: exact-pinned dependencies + committed lockfile; `npm ci`; Dependabot (npm + GitHub Actions); OSV-Scanner or `npm audit` in CI failing on high/critical; GitHub Actions pinned to commit SHAs with minimal `permissions:`; CodeQL; branch protection on `main` (PR + passing CI). Minimize dependencies; justify each in PROGRESS.md. |
| SEC-11 | **Rate limiting** on every public write/expensive endpoint (likes, beacon, contact, search, random). |
| SEC-12 | **Errors**: generic messages to clients; no stack traces; structured server logs **without IPs or PII**. |
| SEC-13 | **Audit log** of every admin mutation (ADM-16). |
| SEC-14 | **DNS/domain**: DNSSEC on; CAA records permitting only the CAs Cloudflare uses; no dangling records; registrar lock (owner task). |
| SEC-15 | `/.well-known/security.txt` with a contact and expiry. |
| SEC-16 | **Security testing**: an OWASP ZAP baseline scan against staging in CI; a full active ZAP scan and ASVS checklist review in M7; an optional third-party pen test before or after launch. |

---

## 7. Privacy & legal

Context: the owner is **US-based**; the site is non-commercial and doesn't target the EU. GDPR very likely doesn't apply, and CCPA and other state privacy laws don't (thresholds not met). We design privacy-first anyway.

| ID | Requirement |
|---|---|
| PRV-01 | No cookies and no browser storage on public/media hosts (INV-3). In-memory state only (shuffle order, sound preference, layout via URL). |
| PRV-02 | No third-party requests from public pages: self-host fonts and all assets; no external embeds (YouTube, Instagram, maps tiles, etc.). The dashboard map renders from bundled geometry. |
| PRV-03 | Never store raw IPs. Only daily-rotated, salted HMACs ≤48 h (ANL-03, CON-03). |
| PRV-04 | Logs: no IPs/PII in application logs; keep Workers log retention at the minimum. |
| PRV-05 | **Privacy policy page** (CalOPPA-friendly): what's collected (aggregate views, country/region, referrer host; likes via short-lived hashed dedupe; contact submissions), why, retention, processors (Cloudflare, Backblaze), no cookies, no selling or sharing, Do Not Track / Global Privacy Control respected (nothing to opt out of), contact method, effective date. |
| PRV-06 | Instagram import discards third-party data (IMP-02). |
| PRV-07 | Pre-publish personal-info reminder (ADM-18). |
| PRV-08 | Future comments/discussion require revisiting: DMCA designated agent registration, moderation, data deletion vs. backups. |

---

## 8. Malware & abuse prevention
| ID | Requirement |
|---|---|
| ABU-01 | Only the owner can upload (INV-5). No visitor content is ever rendered. |
| ABU-02 | All media decoded and re-encoded (MED-02/08), which neutralizes polyglot/embedded payloads. SVG and other active formats are rejected (MED-01). |
| ABU-03 | Media served from a separate host with strict `Content-Type` + `nosniff` (MED-10). |
| ABU-04 | Documents (PDFs etc.) are admin-only and always served as `attachment`. |
| ABU-05 | No third-party scripts on public pages (Turnstile on /contact excepted). |
| ABU-06 | Contact form can't be used as a mail relay (CON-04/05). |
| ABU-07 | Owner sets up Google Search Console + Safe Browsing alerts (owner task O-07). |

---

## 9. Backups & recovery

| ID | Requirement |
|---|---|
| BAK-01 | **D1 Time Travel**: point-in-time restore to any minute within the last 30 days (requires Workers Paid). |
| BAK-02 | **Nightly DB export** to Backblaze B2 bucket `{{DOMAIN}}-db-backups` (dots → hyphens, D-27). Retention: **30 daily + 12 monthly** (1st-of-month copies). Server-side encryption on. |
| BAK-03 | **Nightly media sync**: `media-private` (originals, documents, captions) → B2 bucket `{{DOMAIN}}-media-backups` (dots → hyphens, D-27) with **versioning**. Deleted or replaced objects remain as prior versions for **365 days**, then lifecycle-purged. (Public derivatives are regenerable and needn't be backed up.) |
| BAK-04 | **Object Lock (governance mode)** on both B2 buckets, with retention matching the schedules above, so stolen routine credentials can't destroy backups. |
| BAK-05 | Backup job credentials: write/list only, **no delete**, no bypass-governance. A separate **break-glass key** with `bypassGovernanceRetention` is created by the owner, stored offline, and used only for the emergency purge runbook. |
| BAK-06 | Backup jobs run as scheduled jobs (Worker Cron Trigger or a GitHub Actions schedule; implementer chooses, documents why) and alert the owner by email on failure. |
| BAK-07 | Runbooks in `docs/runbooks/`: `restore-db.md` (Time Travel and from B2), `restore-media.md`, `emergency-purge.md`, `rotate-secrets.md`. |
| BAK-08 | **Restore drill**: verified restore into staging at the end of M1, then **quarterly**. `npm run backup:verify` checks that the latest backups exist and are readable. |
| BAK-09 | App-level safety nets: trash (ADM-04) and revisions (ADM-05). |

---

## 10. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | **Performance** (p75, mid-range phone, 4G): LCP ≤ 2.5 s, CLS < 0.1, INP < 200 ms. JS per public page ≤ 30 KB gzip, excluding the feed/carousel island (≤ 60 KB). CDN caching of public HTML with purge on change. |
| NFR-02 | **Responsive** 320 px → 4K, touch-first, also great with mouse/keyboard. |
| NFR-03 | **Accessibility** WCAG 2.2 AA: alt text, full keyboard operation (carousel, feed, slideshow, wheel), visible focus, sufficient contrast, `prefers-reduced-motion`, captions support, gesture alternatives. axe checks in CI. |
| NFR-04 | **Cost**: ≤ $5/mo + domain, assuming ≤ 5,000 items, ≤ 100 GB media, ≤ 200k page views/month. Flag anything that would exceed it. |
| NFR-05 | **Browsers**: last 2 versions of Chrome, Edge, Firefox, Safari (macOS + iOS). Admin: latest Chrome and Safari including iOS Safari. |
| NFR-06 | **Reliability**: no single upload failure can corrupt or lose existing data; uploads are resumable or safely retryable. |

---

## 11. Quality, operations, future

### 11.1 Testing
| ID | Requirement |
|---|---|
| TST-01 | Vitest unit/integration tests (Workers runtime via the Cloudflare Vitest pool); Playwright e2e across Chromium + WebKit; axe accessibility checks. |
| TST-02 | **Privacy-leak suite (deploy gate)**: seed unique sentinel strings into every ADMIN field and into draft, private, wishlist and trashed items. Crawl every public route, API, search, sitemap, OG tags, JSON-LD, embeds, the random endpoint, HTML source and media URLs. Assert no sentinel appears anywhere and private media return 404. Re-run after toggling items private ↔ public. |
| TST-03 | AuthZ tests: every admin route rejects missing/invalid Access JWTs (SEC-03). |
| TST-04 | Header tests: CSP/HSTS/etc. present and correct on every host and route type. |
| TST-05 | Upload tests: rejects SVG, wrong magic bytes, polyglots, oversize, >60 s video; verifies GPS is absent from all outputs. |
| TST-06 | Feed/video tests: muted start; sound preference carries to the next video after unmute; resets on reload; only one video plays. |

### 11.2 CI/CD & environments
| ID | Requirement |
|---|---|
| OPS-01 | Environments: local (`wrangler dev`), staging, production, each with separate D1, R2 and B2 resources. Staging entirely behind Access. |
| OPS-02 | GitHub Actions: lint, typecheck, unit, e2e, privacy-leak suite, CodeQL, dependency scan, ZAP baseline (staging). Auto-deploy staging from `main`; production on manual approval/tag. |
| OPS-03 | Migrations: Drizzle-generated SQL, forward-only, applied in CI; production migration runs only after a fresh backup succeeds. |

### 11.3 Future (design hooks only, do NOT build)
- FUT-01: Comments and/or a discussion board with visitor accounts. Keep the schema and auth layering such that a `users` table and a visitor auth system can be added later without restructuring the owner/admin model.
- FUT-02: Comments would reintroduce visitor content. ABU/PRV/BAK must be revisited first (PRV-08).

---

## 12. Milestones (build in order; stop for owner review after each)

| # | Milestone | Scope | Exit criteria |
|---|---|---|---|
| M0 | Foundations | Repo scaffold (Astro, TS strict, two Workers, shared package), D1/R2 bindings, Drizzle setup, CI pipeline, lint/test harness, baseline security headers, Access on admin + staging, threat model + ASVS checklist skeleton, PROGRESS.md, CLAUDE.md commands filled in | Hello-world public + admin on staging; admin rejects unauthenticated requests (TST-03); headers test passes; CI green |
| M1 | Core gallery | Data model (§4), item CRUD, status toggle, trash, revisions, photo pipeline (MED-01–07, 10, 13), categories tree + multi-category, tags, public home/grid/category/item pages, vertical feed (PUB-05), search (PUB-08), 404 behavior, basic OG, privacy-leak suite, **backups + restore drill** | Owner can photograph an item on iPhone, publish it, and see it publicly; toggling private removes it everywhere ≤60 s; TST-02 passes; restore drill succeeds |
| M2 | Import / export | IMP-01–07 | Owner's real Instagram export imports as drafts with no duplicates on re-run; CSV round-trip works; full archive downloads |
| M3 | Organization & discovery | PUB-02/03 layouts, filters, sorts; ADM-07–12 (tags, custom fields, bulk, admin filters, wishlist, parting); PUB-09/10 surprise me + shuffle | All ACs pass; leak suite covers the new fields |
| M4 | Video | MED-08/09/12, PUB-06 | 60 s iPhone clip uploads from phone; plays muted; sound preference carries; GPS stripped; Range requests work in Safari |
| M5 | Presentation & rights | MED-06 watermark + regeneration, RGT-01–07, PUB-11–14 (slideshow, static pages, embed, SEO/sitemap), MED-11 hotlink, §5.7 contact form | Licensable JSON-LD validates; embed works on an external test page; contact email arrives with spam controls verified |
| M6 | Collector tools & analytics | ADM-13/14/17, ANL-01–06, dashboard | Dashboard shows views/likes/geo/value data from staging traffic; no raw IP anywhere in storage |
| M7 | Hardening & launch | ASVS L2 review, full ZAP scan, perf + a11y audits, restore drill, production setup, DNS hardening, HSTS preload, launch checklist (`docs/runbooks/launch.md`) | All checklists complete; no open high/critical findings; owner sign-off |

---

## 13. Decision log (settled — do not re-litigate)

| ID | Decision | Rationale |
|---|---|---|
| D-01 | Cloudflare Workers + D1 + R2 | Near-zero cost, no servers to patch, built-in CDN/DDoS protection, R2 has no egress fees |
| D-02 | Astro | Content/image-heavy site; minimal JS; islands for interactivity |
| D-03 | Cloudflare Access (passkey IdP) instead of in-app auth | No password system to attack; phishing-resistant; free |
| D-04 | Separate public and admin Workers/hosts | Shrinks the public attack surface |
| D-05 | Backblaze B2 for off-site backups with Object Lock | Different provider = survives a Cloudflare account compromise; cheap |
| D-06 | Backups: Time Travel 30 days + 30 daily + 12 monthly; media versions 365 days | Owner adds content infrequently; storage cost is negligible |
| D-07 | Owner can permanently delete media; backup copies expire per schedule; emergency purge via break-glass key | Balances decluttering with ransomware protection |
| D-08 | Categories: single-parent tree, unlimited depth; items in many categories; no separate "Exhibits" | Matches the owner's mental model (e.g. Meteorites › Chondrites › H) |
| D-09 | No PWA / no install prompts | Owner preference |
| D-10 | No comments in v1 | Removes the largest spam/malware/legal surface |
| D-11 | License: CC BY-NC 4.0 default, per-category/item overrides, ARR for third-party artwork (e.g. book covers) | Owner's long-standing preference; can't license what you don't own |
| D-12 | Small corner watermark on public derivatives, originals kept private | Deterrence without ruining photos; regenerable |
| D-13 | Max public image 2048 px; no right-click blocking | Most effective low-cost protection; blocking is futile and hurts UX |
| D-14 | Video: MP4 H.264/AAC, ≤60 s, ≤1080p, browser-side encode | Universal playback; zero egress cost on R2 |
| D-15 | Video starts muted; unmute persists for the visit (memory only) | Respectful default, low friction |
| D-16 | No Cloudflare Web Analytics JS; first-party beacon + zone analytics | Keeps "no third-party scripts" |
| D-17 | Geo = country + region aggregates only | Owner wants "where from," not who |
| D-18 | Contact form via Cloudflare `send_email`, Turnstile on that page only | No extra vendors; one contained exception to the no-third-party rule |
| D-19 | US-based; GDPR likely N/A; privacy-first design regardless; privacy policy page kept | Low cost, avoids future compliance work |
| D-20 | The GitHub repository is **public** (2026-11-13, M0) | On GitHub Free, CodeQL code scanning, branch protection and push protection are free only for public repos; a private repo would need paid plans (breaks INV-6). No secrets or personal data are committed. |
| D-21 | Until the domain exists, staging runs on `*.workers.dev` hostnames behind Access. **Domain to be registered before M1 ends.** | Allowed by O-04. `workers.dev` can't exercise CDN caching/purge, so MED-10 and the M1 "removed everywhere ≤60 s" AC need the real domain. |
| D-22 | Access is applied **per Worker** ("Protect this Worker behind Access", all traffic), not per hostname. Login method: GitHub only, Instant Auth on, one-time PIN deleted, session 24 h, policy = owner's GitHub primary email only. See `docs/runbooks/access-setup.md`. | Covers `workers.dev`, preview URLs and future custom domains, so a forgotten route can't be public. |
| D-23 | Accepted residual risk: Access can't verify *how* the owner signed in to GitHub. Passkey/MFA enforcement (SEC-02) relies on the GitHub account's settings (passkey + mandatory 2FA); GitHub's password + TOTP fallback is phishable. | GitHub OAuth gives Access no authentication-method claim. Mitigation: sign in with the passkey; keep recovery codes offline. |
| D-24 | CI gets an Access **service token** (`ci-staging`) allowed only on the **public** staging app (Service Auth policy). Admin staging stays email-only. | Lets CI smoke-test, ZAP-scan and (from M1) leak-test real staging (OPS-02, TST-02, SEC-16). A leaked token exposes only what the public site would show. |
| D-25 | Staging serves media from a path on the staging public host instead of a separate `media.` host. The media origin is configurable. Production keeps `media.{{DOMAIN}}` (ABU-03). Details in M1. | A separate Access-protected media host would break `<img>` loads (the Access cookie is per host). Amends §3.1 for staging only. |
| D-26 | If `admin.staging.{{DOMAIN}}` can't get a certificate (two-level subdomain), use `staging-admin.{{DOMAIN}}`. Check when the domain is registered. | Universal SSL covers one subdomain level only. |
| D-27 | B2 bucket names replace dots in the domain with hyphens (e.g. `example-com-db-backups`). Amends BAK-02/03. | B2 names allow only letters, digits and hyphens. |
| D-28 | `{{OWNER_EMAIL}}` is split: `ADMIN_EMAIL` (Access identity, a Worker secret) and a separate contact-form destination (M5). They may hold the same address. | They're different jobs (CON-05 vs SEC-02/03). |
| D-29 | The admin Worker runs **before** static assets (`assets.run_worker_first: true`) and does its own JWT validation per SEC-03. It doesn't rely on the runtime's `ctx.access`. | SEC-03 says "every request"; by default static assets skip the Worker. Independent validation is the specified defense in depth. |
| D-30 | `preview_urls: false` on every Worker; production Workers have `workers_dev: false` until they get their custom domain. | Version/preview URLs are public by default, and `workers_dev: false` doesn't disable them. |
| D-31 | The CSP is one shared policy (`packages/core/src/headers.ts`), sent as an HTTP header by the Workers and via `_headers` for static assets. No inline scripts or styles anywhere (CSS ships as files). Astro's `<meta>`-based CSP feature isn't used. Under `astro dev` only, the CSP is sent Report-Only; builds and deployments always enforce. | A `<meta>` CSP can't set `frame-ancestors`, and a single source keeps every route identical (TST-04). The dev server injects inline styles; it is never deployed. |
| D-32 | Workers invocation logs are disabled; only our own structured logs (no IPs/PII) are kept. | PRV-04: invocation logs record request metadata. |
| D-33 | Supply chain: npm `min-release-age=7` and Dependabot `cooldown` 7 days; npm's default blocking of install scripts is kept (none are needed); TypeScript held at 6.0.x (typescript-eslint and @astrojs/check don't support 7 yet). | Reduces exposure to compromised fresh releases (SEC-10). |
| D-34 | Workers-runtime unit tests use `@cloudflare/vitest-plugin`, the renamed successor of `@cloudflare/vitest-pool-workers` (TST-01). | The old package is deprecated. |
| D-35 | `astro dev` for admin skips Access validation through a dev-only pipeline. It exists only behind the build-time `import.meta.env.DEV` constant, refuses unless `ENVIRONMENT=local`, and `npm run check:bundle` fails the build if its marker appears in any build output. | There's no Access in front of the local dev server. Built previews (and e2e tests) always validate. |
| D-36 | Dependency scanning uses `npm audit --audit-level=high` (not OSV-Scanner); secret scanning uses gitleaks in CI plus GitHub secret scanning/push protection. | SEC-10 allows either; fewer tools. |
| D-37 | Values that could identify the owner's Cloudflare account (the `workers.dev` subdomain, the Access team name, AUD tags) are **not committed**. They're stored as GitHub `staging` environment **secrets** (so they're masked in the public Actions logs; the workflow also masks the bare hostname, subdomain and team name) and injected at deploy time (`scripts/deploy-staging.ts`, `wrangler deploy --var`). Committed configs hold `SET_AT_DEPLOY` placeholders, which fail config validation (fail closed) if not overridden. | The repo is public (D-20); the subdomain is personal. |

---

## 14. Assumptions to verify against current vendor docs (may be stale)

1. Cloudflare pricing/free tiers for Workers, D1, R2, Email sending, Turnstile, Access (Zero Trust free tier seat limit).
2. D1 Time Travel retention (assumed 30 days on Workers Paid) and that D1 supports FTS5.
3. R2 lacks S3-style object versioning (the design doesn't depend on it).
4. The R2 presigned URL flow, and the Workers request-size/CPU limits for the finalize step.
5. Cloudflare `send_email` binding: sending to a verified Email Routing destination; limits.
6. Workers rate-limiting binding availability/semantics.
7. `request.cf.region` availability and accuracy.
8. Backblaze B2 Object Lock governance mode + `bypassGovernanceRetention` capability; lifecycle rules for versions; application key capability granularity (write without delete).
9. Browser support: WebCodecs `VideoEncoder`/`AudioEncoder` (especially iOS Safari), HEIC decode in Safari, WebP encode via canvas or WASM.
10. The Cloudflare AI-crawler blocking setting and the current list of AI crawler user agents.
11. The current Instagram export JSON layout.
12. The current OWASP ASVS version (assumed 5.0) and OWASP Top 10 edition.
13. Google Images "Licensable" structured-data requirements.
14. The Open Library API (ISBN endpoint, rate limits, usage policy; set a descriptive generic User-Agent, no personal data).

If an assumption is false, propose an alternative that preserves the invariants and log it in §13.

---

## 15. Owner tasks (human-only)

| ID | Task | Needed by |
|---|---|---|
| O-01 | Create a Cloudflare account; enable a passkey/MFA; subscribe to Workers Paid ($5/mo) | M0 |
| O-02 | Create a GitHub repo; enable MFA/passkey; give Claude Code access | M0 |
| O-03 | Set up the Cloudflare Access identity provider with passkey/MFA enforced (e.g. GitHub or Google account with passkey); confirm OTP login is disabled | M0 |
| O-04 | Choose and register the domain (Cloudflare Registrar recommended; avoid `.top`, `.xyz`, `.zip`, `.mov`); enable registrar lock + DNSSEC. Staging can use a temporary `*.workers.dev` hostname behind Access until then | M0–M7 |
| O-05 | Create a Backblaze B2 account (MFA); create the break-glass key and store it offline | M1 |
| O-06 | Enable Cloudflare AI-crawler blocking; verify the Email Routing destination address | M5 |
| O-07 | Set up Google Search Console + Safe Browsing alerts | M7 |
| O-08 | Request the Instagram data export (JSON) early, since it can take time to prepare | Before M2 |
| O-09 | Provide owner display name, About text, watermark text and an avatar/hero image | M5 |
| O-10 | Optional: US Copyright Office group registration of published photographs | Any time |

---

## 16. Defaults chosen without explicit owner input (owner may change)

- Like counts visible only in admin (`like_count_public = false`).
- Direct-loaded item feed context = all public items, newest first.
- Image derivative widths 400/800/1200/1600/2048, WebP; watermark only on ≥800 px.
- Upload size caps: images 30 MB, video 100 MB (original).
- Contact submissions auto-deleted after 180 days unless linked to a grant; rate limit 3/hour per visitor, 30/day global.
- Slideshow interval default 6 s.
- Default currency USD.
- Default credit format: "Photo: {{OWNER_NAME}} / {{DOMAIN}}".
- "Books" category seeded with All Rights Reserved license.
