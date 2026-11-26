# Collection Gallery — Requirements Specification

Version 1.0 · 2026-11-14 · Owner: {{OWNER_NAME}} · Status: **Approved for build**

---

## 0. How to read this document

- **MUST / MUST NOT / SHOULD / MAY** follow RFC 2119.
- Every requirement has a stable ID (e.g. `PUB-05`). Reference IDs in commits, tests and `PROGRESS.md`.
- `AC:` lines are acceptance criteria. Make them automated tests wherever feasible.
- **[PUBLIC]** means anyone browsing can see it. **[ADMIN]** means only the owner sees it, in the admin app.
- Placeholders: `{{OWNER_NAME}}` (a **pen name**, never the real name, D-49), `{{DOMAIN}}` (not chosen yet, must be configurable), `{{OWNER_EMAIL}}` (the only identity allowed into admin; set via config, never committed).
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
- ARC-04: Media is processed **in the admin's browser** (§5.2), then uploaded **through the admin Worker into R2** (D-46, replacing presigned URLs). A finalize call makes the server verify the object (type, size, dimensions or duration) before attaching it to an item.

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
| MED-02 | **Client-side processing** in the admin browser before upload: decode → apply EXIF orientation → **strip all metadata** (GPS especially) → re-encode (master and derivatives per D-43). HEIC must work on iPhone Safari (D-48); on browsers that can't decode HEIC, use a well-maintained WASM decoder or show a clear error. |
| MED-03 | **Server verification** on finalize: magic-byte type check, max size (images 30 MB original, video 100 MB original), dimensions/duration limits; reject on any mismatch. |
| MED-04 | **Originals** (the metadata-stripped JPEG master, D-43) are stored as uploaded in `media-private` (never public; admin-download only, served as `Content-Disposition: attachment`). They're used to regenerate derivatives. |
| MED-05 | **Public image derivatives** in `media-public`: long-edge widths 400, 800, 1200, 1600, **2048 max**; WebP; plus one JPEG 1200 px for Open Graph. Served with `srcset`/`sizes` and explicit width/height. **Originals are never served publicly.** |
| MED-06 | **Watermark**: small, semi-transparent text (setting `watermark_text`, default `© {{OWNER_NAME}} · {{DOMAIN}}`) in the bottom-right corner, burned into derivatives ≥800 px and into video. A global setting plus per-item override. Changing the text or setting triggers regeneration of affected derivatives (admin-browser job with a progress UI). |
| MED-07 | **Embedded rights metadata**: after stripping, write back **only** creator/artist and copyright notice (the pen name, D-49) (EXIF and/or XMP) into public derivatives. Never GPS or camera serials. |
| MED-08 | **Video output**: ≤ **120 s** (reject longer; a start/end trim is offered; D-59), MP4 container, **H.264 video + AAC-LC audio**, ≤1080p, ~4–5 Mbps target, `faststart` (moov atom first), metadata stripped, watermark burned in, poster frame (owner-selectable, default first frame). Encoding happens in the browser via WebCodecs (or a well-maintained wrapper). Fallback if infeasible: Cloudflare Stream (requires owner approval, cost impact). |
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
| IMP-01 | **Instagram import**. The owner downloads their data from Meta Accounts Center ("Download your information", **JSON** format) and uploads the zip in admin. Processing happens **in the browser**: parse posts → for each post create a **Draft** item (caption → description (hashtags handled per D-42), timestamp → posted_at, carousel media → item media, run through the full MED pipeline including metadata stripping and the 120 s video limit, D-59). |
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
| BAK-06 | Backup jobs run as scheduled jobs (chosen: a dedicated backup Worker's Cron Trigger, D-47) and alert the owner by email on failure. |
| BAK-07 | Runbooks in `docs/runbooks/`: `restore-db.md` (Time Travel and from B2), `restore-media.md`, `emergency-purge.md`, `rotate-secrets.md`. |
| BAK-08 | **Restore drill**: verified restore into staging at the end of M1, then **quarterly**. `npm run backup:verify` checks that the latest backups exist and are readable. |
| BAK-09 | App-level safety nets: trash (ADM-04) and revisions (ADM-05). |

---

## 10. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | **Performance** (p75, mid-range phone, 4G): LCP ≤ 2.5 s, CLS < 0.1, INP < 200 ms. JS per public page ≤ 30 KB gzip, excluding the feed/carousel island (≤ 60 KB). CDN caching of public HTML with purge on change (from M7; TTL of 60 s or less, D-45). |
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
| TST-05 | Upload tests: rejects SVG, wrong magic bytes, polyglots, oversize, >120 s video (D-59); verifies GPS is absent from all outputs. |
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
| M4 | Video (built before M2, D-59) | MED-08/09/12, PUB-06 | 120 s iPhone clip uploads from phone; plays muted; sound preference carries; GPS stripped; Range requests work in Safari |
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
| D-21 | Until the domain exists, staging runs on `*.workers.dev` hostnames behind Access. **Domain to be registered before M1 ends.** | Allowed by O-04. `workers.dev` can't exercise CDN caching/purge, so MED-10 and the M1 "removed everywhere ≤60 s" AC need the real domain. **Amended 2026-11-23 (D-45):** staging stays on `workers.dev` through M1, with no edge caching anywhere in M1; the move to the domain and edge caching come together in M7. |
| D-22 | Access is applied **per Worker** ("Protect this Worker behind Access", all traffic), not per hostname. Login method: GitHub only, Instant Auth on, one-time PIN deleted, session 24 h, policy = owner's GitHub primary email only. See `docs/runbooks/access-setup.md`. | Covers `workers.dev`, preview URLs and future custom domains, so a forgotten route can't be public. **Corrected 2026-11-23:** the Worker-level Access toggle covers `workers.dev`, preview and version URLs **only, not custom domains** (Cloudflare docs, Workers > workers.dev routing). Any custom domain on staging or admin needs its own hostname-based Access application, and it **must exist before the custom domain is attached**. With a separate Access app per host, the admin Worker must validate that app's AUD. |
| D-23 | Accepted residual risk: Access can't verify *how* the owner signed in to GitHub. Passkey/MFA enforcement (SEC-02) relies on the GitHub account's settings (passkey + mandatory 2FA); GitHub's password + TOTP fallback is phishable. | GitHub OAuth gives Access no authentication-method claim. Mitigation: sign in with the passkey; keep recovery codes offline. |
| D-24 | CI gets an Access **service token** (`ci-staging`) allowed only on the **public** staging app (Service Auth policy). Admin staging stays email-only. | Lets CI smoke-test, ZAP-scan and (from M1) leak-test real staging (OPS-02, TST-02, SEC-16). A leaked token exposes only what the public site would show. |
| D-25 | Staging serves media from a path on the staging public host instead of a separate `media.` host. The media origin is configurable. Production keeps `media.{{DOMAIN}}` (ABU-03). Details in M1. | A separate Access-protected media host would break `<img>` loads (the Access cookie is per host). Amends §3.1 for staging only. |
| D-26 | If `admin.staging.{{DOMAIN}}` can't get a certificate (two-level subdomain), use `staging-admin.{{DOMAIN}}`. Check when the domain is registered. | Universal SSL covers one subdomain level only. **Resolved 2026-11-23:** Workers Custom Domains issue an Advanced Certificate for the exact hostname, including multi-level ones (`admin.staging.{{DOMAIN}}` works), at no extra cost. |
| D-27 | B2 bucket names replace dots in the domain with hyphens (e.g. `example-com-db-backups`). Amends BAK-02/03. | B2 names allow only letters, digits and hyphens. |
| D-28 | `{{OWNER_EMAIL}}` is split: `ADMIN_EMAIL` (Access identity, a Worker secret) and a separate contact-form destination (M5). They may hold the same address. | They're different jobs (CON-05 vs SEC-02/03). |
| D-29 | The admin Worker runs **before** static assets (`assets.run_worker_first: true`) and does its own JWT validation per SEC-03. It doesn't rely on the runtime's `ctx.access`. | SEC-03 says "every request"; by default static assets skip the Worker. Independent validation is the specified defense in depth. |
| D-30 | `preview_urls: false` on every Worker; production Workers have `workers_dev: false` until they get their custom domain. | Version/preview URLs are public by default, and `workers_dev: false` doesn't disable them. |
| D-31 | The CSP is one shared policy (`packages/core/src/headers.ts`), sent as an HTTP header by the Workers and via `_headers` for static assets. No inline scripts or styles anywhere (CSS ships as files). Astro's `<meta>`-based CSP feature isn't used. Under `astro dev` only, the CSP is sent Report-Only; builds and deployments always enforce. | A `<meta>` CSP can't set `frame-ancestors`, and a single source keeps every route identical (TST-04). The dev server injects inline styles; it is never deployed. |
| D-32 | Workers invocation logs are disabled; only our own structured logs (no IPs/PII) are kept. | PRV-04: invocation logs record request metadata. |
| D-33 | Supply chain: npm `min-release-age=7` and Dependabot `cooldown` 7 days; npm's default blocking of install scripts is kept (none are needed); TypeScript held at 6.0.x (typescript-eslint and @astrojs/check don't support 7 yet). | Reduces exposure to compromised fresh releases (SEC-10). |
| D-34 | Workers-runtime unit tests use `@cloudflare/vitest-plugin`, the renamed successor of `@cloudflare/vitest-pool-workers` (TST-01). | The old package is deprecated. |
| D-35 | `astro dev` for admin skips Access validation through a dev-only pipeline. It exists only behind the build-time `import.meta.env.DEV` constant, refuses unless `ENVIRONMENT=local` and the request host is loopback (D-41), and `npm run check:bundle` fails the build if its marker appears in any build output. | There's no Access in front of the local dev server. Built previews (and e2e tests) always validate. |
| D-36 | Dependency scanning uses `npm audit --audit-level=high` (not OSV-Scanner); secret scanning uses gitleaks in CI plus GitHub secret scanning/push protection. | SEC-10 allows either; fewer tools. |
| D-37 | Values that could identify the owner's Cloudflare account (the `workers.dev` subdomain, the Access team name, AUD tags) are **not committed**. They're stored as GitHub `staging` environment **secrets** (so they're masked in the public Actions logs; the workflow also masks the bare hostname, subdomain and team name) and injected at deploy time (`scripts/deploy-staging.ts`, `wrangler deploy --var`). Committed configs hold `SET_AT_DEPLOY` placeholders, which fail config validation (fail closed) if not overridden. | The repo is public (D-20); the subdomain is personal. **Defence in depth only** (security review 2026-11-22): the subdomain matches the start of the GitHub owner name, so the staging hostnames can be inferred from public logs. Access is the actual control. |
| D-38 | `main` is protected by a repository **ruleset** (2026-11-22): PR required with **0 approvals**, required checks (CI lint/typecheck/unit/build, e2e, gitleaks, both CodeQL analyses) and branches up to date, CodeQL results gate (errors; security high+), linear history, no force-push or deletion, no bypass actors; squash merges only. | SEC-10 asks for PR + passing CI. There is a single owner and GitHub doesn't let an author approve their own PR, so an approval count of 1 would block every change; CI is the gate. The owner can disable the ruleset in an emergency. |
| D-39 | **Production deploy credentials are separate from staging (decide the form by M7).** The staging CI token (Workers Scripts Edit + D1 Edit) is account-wide; Cloudflare can't scope it to individual Workers or databases. Before any production resource exists, either (a) production gets its own token in a `production` GitHub environment that requires the owner's approval, or (b) staging moves to a separate Cloudflare account. Until then the account-wide staging token is accepted. | Security review 2026-11-22. Once production shares the account, a leaked staging token could otherwise overwrite production or read its data. |
| D-40 | GitHub repository security settings (2026-11-22): secret scanning and push protection on; private vulnerability reporting on; Dependabot security updates on; Actions limited to GitHub-owned actions plus `gitleaks/gitleaks-action`, with full-SHA pinning required; workflow runs from all outside contributors need approval; admins can't bypass the `staging` environment. Validity checks and non-provider patterns need paid GitHub Secret Protection, so they stay off. | Security review 2026-11-22. Push protection blocks a leaked token before it's public; gitleaks only finds it afterwards. |
| D-41 | Each Worker's top-level Wrangler config is local development only, named `cg-<app>-local` (not the production name). Staging and production are explicit environments. Dev-server behaviour (admin Access bypass, public Report-Only CSP) also requires `ENVIRONMENT=local` **and** a loopback request host, and builds refuse a non-production `NODE_ENV`. | Security review 2026-11-22. A stray bare `wrangler deploy` or a development build could otherwise put local settings or the dev bypass under the production name. |
| D-42 | **Instagram captions and hashtags (amends IMP-01; owner decision 2026-11-23).** The caption becomes the description, cleaned: the trailing hashtag block is removed, hashtags inside sentences keep the word without the `#`, and Meta's mis-encoded text (UTF-8 read as Latin-1) is repaired. **No hashtag becomes a tag automatically.** Each imported draft keeps, admin-only, the original caption and its hashtags as suggestions the owner can add as tags with one click. Both fields are admin-only and covered by the privacy-leak suite (TST-02). The import uses `posts_1.json`/`reels.json` and discards EXIF/device data from the JSON. | The owner overused hashtags, often jokily (2,885 distinct, a median of 14 per post, 2,135 used once). Tags are curated by hand (bulk tagging in M3). The original caption is kept so nothing is lost (INV-2). |
| D-43 | **Originals and metadata (amends MED-02/MED-04; owner decision 2026-11-23).** The stored original is a full-quality **JPEG master** made on the device: orientation applied, **all metadata removed** (GPS, camera/lens serials, device model, software, timestamps; exposure data too, since nothing needs it), long edge capped at **4608 px (about 16 MP)**. It is stored privately as uploaded (MED-04). The camera file itself never leaves the device. Public derivatives stay at max 2048 px (D-13); the item page offers a full-screen view up to 2048 px. Only creator and copyright are written back into public derivatives (MED-07). | The owner wants nothing that could identify them, alone or in combination. Full-resolution 48 MP canvases risk exhausting iPhone Safari memory. JPEG is the most portable master format, as the owner prefers. |
| D-44 | **WebP encoding in the browser (owner approved 2026-11-23).** Safari (iOS and macOS) can't encode WebP from a canvas (it silently returns PNG; WebKit bug 226950). The admin app encodes WebP with `@jsquash/webp` (libwebp compiled to WebAssembly), loaded only in admin. The **admin** CSP adds `'wasm-unsafe-eval'` (WebAssembly compilation only; scripts remain `'self'`). The public CSP is unchanged. | Keeps WebP derivatives (MED-05, smaller pages, NFR-01) on the owner's main device. The alternative (JPEG-only derivatives, about 25-30% larger) was rejected. |
| D-45 | **No edge caching in M1; caching with the domain move in M7.** Every public page and media request is served live, and the public Worker checks the parent item's visibility on every media request (MED-10), so hiding takes effect immediately. In M7, public HTML and media get edge caching with a TTL of 60 s or less (Workers Caching or the Cache API), which meets the 60 s AC without a purge credential. | Cloudflare docs: the Cache API isn't available behind Access (so staging can't test it), and `cache.delete` purges one data centre only. Live serving is well within quotas at this scale. Amends NFR-01's timing and D-21. |
| D-46 | **Uploads go through the admin Worker (amends ARC-04).** Processed files are sent to the admin Worker, which streams them into R2 via the bucket binding: a single PUT up to 100 MB (the Workers request limit), or an R2 multipart upload (parts of 5 MiB or more, resumable) for large files. Finalize still verifies type, size and dimensions server-side (MED-03). No presigned URLs. | Presigned R2 URLs need separate S3 credentials, only work on the account-ID S3 hostname, and would add that hostname (with the account ID, see D-37) to the admin `connect-src`. Proxying keeps the CSP unchanged, adds no credential, and makes uploads resumable (NFR-06). |
| D-47 | **Backups (BAK-02/03/06).** A separate, routeless **backup Worker** (`cg-backup-<env>`) runs nightly on a Cron Trigger. Its bindings are DB plus `media-private`, plus Backblaze keys as secrets; it has no HTTP route and `workers_dev` is off.<br>&bull; **Database:** exported **table by table to JSON**, skipping FTS5 virtual tables, which are rebuilt on restore. `wrangler d1 export` and the REST export can't export databases with virtual tables.<br>&bull; **Media:** `media-private` is synced into a versioned B2 bucket.<br>&bull; **Object Lock** (governance mode) is set per object.<br>&bull; **Keys:** the job key has `writeFiles`, `writeFileRetentions`, `readFileRetentions`, `listFiles` and `readFiles`, with **no `deleteFiles` and no `bypassGovernance`**. The `backup:verify` key is read-only. The break-glass key is kept offline.<br>&bull; **Failure alerts:** email through the `send_email` binding to the owner's verified address, which is stored as a secret and never committed. A weekly GitHub Actions `backup:verify` check is a second, independent channel.<br>&bull; **Email Routing** is enabled on the domain in M1 (moved from O-06). No routing rules are created, so inbound mail is refused.<br>&bull; **B2 sign-in:** Backblaze offers TOTP, not passkeys. TOTP with SMS fallback off and offline backup codes is accepted. | A Worker cron doesn't depend on the public repo staying active (GitHub disables scheduled workflows after 60 days of inactivity). Least privilege: neither the admin nor the public Worker holds backup credentials. JSON export also serves IMP-07. |
| D-48 | **HEIC input (MED-01/02; owner decision 2026-11-23).** HEIC/HEIF is accepted where the browser decodes it natively: Safari on iOS/macOS 17 and later, the owner's devices. Elsewhere, for example desktop Chrome, the admin shows a clear message to use Safari or a JPEG. No HEIC WebAssembly decoder is shipped. Stored and served formats: JPEG master (D-43), WebP derivatives plus a 1200 px JPEG for Open Graph. | Avoids a large LGPL decoder (about 26 MB package) for a case the owner doesn't need. JPEG and WebP are the most portable formats. |
| D-49 | **`{{OWNER_NAME}}` is a pen name, never the owner's real name (owner decision 2026-11-23).** Every place that names the owner uses the display-name setting, which holds a pseudonym: MED-07 creator/copyright metadata, the RGT-03 credit line and footer, the MED-06 watermark, RGT-04 JSON-LD `creator`/`creditText`/`copyrightNotice`, OG tags, RGT-05 and the About page. Current pen name: **Insignificant Nobody** (owner's choice 2026-11-23; Oddacious is the fallback), changeable in settings (ADM-15, O-09). The real name is never stored in the repository, configuration, database, media or emails. | The owner doesn't want their real name exposed anywhere. A pseudonym is a valid copyright notice (a generally known alternative designation of the owner). |
| D-50 | **Category reordering and moving use buttons, not drag-and-drop (amends ADM-06's "drag").** Each category has ↑/↓ buttons to reorder it among its siblings and a "Move under" menu listing only valid targets (never itself or its own subcategories; the server rejects cycles too, CNT-01). The owner manages from both phone and desktop (2026-11-23); the buttons work with touch and mouse alike, and desktop drag-and-drop is a candidate extra for the M3 admin polish. | Buttons work reliably with touch on iPhone Safari (ADM-01) and with a keyboard (NFR-03); touch drag-and-drop is fragile and hard to make accessible. |
| D-51 | **Photo upload details (implements MED-01 to 05, 07, 13 with D-43/44/46; recorded 2026-11-24).** (1) **Verify on arrival:** each processed file is checked by the admin Worker *before* it is written to R2 (magic bytes, full JPEG/WebP structure, no trailing data, **no metadata at all**, exactly the planned pixel size, size limit); finalize then confirms every file is stored and attaches them in one batch. This is stricter than MED-03's "on finalize": unverified bytes never reach storage. (2) **Rights metadata comes from the server:** the browser sends metadata-free files and the Worker adds the EXIF creator/copyright block (MED-07) to public files from the `OWNER_NAME` setting, so the client can't inject anything. EXIF is ASCII-only, so the notice reads `Copyright <year> <pen name>`, with any non-ASCII characters dropped. (3) **Sizes:** the master is capped at 4608 px on the long edge *and* 16 MP (iPhone Safari's canvas limit; a square 48 MP photo would otherwise exceed it). Derivatives are never upscaled: a smaller photo gets the listed widths below its size, plus one at its own size. (4) **One request per file** (images are at most 30 MB); R2 multipart arrives with video in M4. Re-sending a file before finalize is safe, which makes uploads retryable (NFR-06). Uploads never finalized are deleted with their files after 24 h. (5) **Removing a photo is soft** (restorable for 30 days, then purged with its files by the daily cron), matching INV-2. A public item can't lose its last photo. | Keeps the server the final authority on what is stored and public (INV-1, INV-3). The owner's "nothing that identifies me" requirement (D-43) is enforced in two places, not one. |
| D-52 | **Photo pipeline e2e harness (TST-05).** The built admin can't be signed in to locally (no Access, by design, SEC-03), so the browser half of the pipeline is tested by serving a minimal copy of the editor's photo section from an intercepted origin, using the **real built admin script** under the **real admin security headers** (CSP with Trusted Types), with the upload API stubbed by the same core planning function as the server. The captured files are checked with the server's own verifier. The server half (verification, storage, rights metadata) runs in workerd in the core tests. | Tests the shipped code under the shipped CSP in WebKit/iPhone WebKit and Chromium without adding any auth bypass to built Workers. |
| D-53 | **Search rate limiting (SEC-11; recorded 2026-11-24).** Search uses the Workers Rate Limiting binding (`SEARCH_LIMITER`, 120 searches per 60 s) with **one shared key**, so the limit applies to the whole site per Cloudflare location, and a visitor over it gets a 429 page. No IP address or other visitor data is used as the key. Each environment has its own namespace. The limit is approximate and per location (Cloudflare docs). Vendor fact to recheck: Cloudflare's docs (rate-limit binding, Workers pricing and limits pages, read 2026-11-24) **don't say which plans include the binding or whether it costs anything**; a Durable Object counter is the fallback if it ever does. | Cloudflare advises against IP keys (shared mobile IPs), and PRV-03 forbids storing IPs. For one owner's gallery, the goal is cost and abuse protection, not fairness between visitors. |
| D-54 | **Public site structure (PUB-01/04/05/07/08/15, M1; recorded 2026-11-24).** URLs: `/`, `/items`, `/category/{slug}`, `/item/{slug}`, `/item/{slug}/photo/{n}` (full-screen view), `/search`, `/feed` (feed fragments) and `/media/{key}` (D-25). The list an item was opened from travels in the query (`?in=`, `&sub=0`, `?q=`), so feed URLs are shareable and need no storage (PRV-01). The **feed** loads neighbouring items as server-rendered HTML fragments (same component and queries as the item page) and follows the item on screen with `history.replaceState`; without JavaScript the item page has plain previous/next links. **Categories appear only when at least one public item is filed under them or their subcategories**; otherwise they give the standard 404, like items. The site title is a placeholder ("Collection Gallery") until the static-pages/settings work in M5. Descriptions use the restricted Markdown in `core/public/markdown.ts`. | One rendering path for items keeps the leak surface small. Hiding empty categories avoids publishing unfinished or private-only parts of the tree. |
| D-55 | **Photo inbox (owner request 2026-11-24; amends ADM-03 and §4.2).** Photos can be uploaded in bulk without an item, into an admin-only **inbox**, through the same on-device pipeline and server checks (MED-02/03, D-43, D-51). From the inbox the owner selects photos and either **creates a draft** from them (title plus categories; the category choice is remembered in page memory for the next draft) or **adds them to an existing item** ("Add from inbox" in the item editor). A photo leaves the inbox when it is assigned. A **Recently used** list links the last assigned photos to their items. Removing an inbox photo is soft (30-day restore, then purged with its files). Data model: a photo may exist without an item **only while it is in the inbox**. Inbox photos are never public: they belong to no item, so no public query or media request can reach them, and the privacy-leak suite (TST-02) covers them. Built as M1 step 5b, after the public site. | The owner photographs many items in one session; one-item-at-a-time uploading is slow on a phone. Sorting can happen later on any device, which also avoids moving HEIC files to a desktop browser that can't open them (D-48). Categories stay on items (not photos) to keep the model clean. **Implemented 2026-11-24:** inbox photos live in their own `inbox_photos` table rather than as `media` rows without an item: making `media.item_id` nullable would need a table rebuild, and dropping `media` cascades to `media_variants` (data loss). Assigning moves rows into `media`/`media_variants` with the same storage keys. The draft dialog keeps the last category in the URL (`?cat=`). |
| D-56 | **Privacy-leak suite design (TST-02; recorded 2026-11-24).** One idempotent seed, `tests/leak/sentinels.sql` (fixed IDs starting `01SENT`, private keys starting `0sentkey`), puts a unique marker in every admin-only column of every table and creates hidden items of each kind, a public item whose private fields are all markers, an old slug of a private item, private photo rows and an inbox photo. A crawler (`tests/leak/crawl.ts`) starts at `/`, follows every link, image, `srcset` and Open Graph URL, runs searches and walks every feed fragment, and fails on any marker, any private storage key or internal ID read from the database, any cookie, or any hidden URL that isn't the identical 404. Two phases: two items are flipped private ↔ public between them. A **self-check** first proves the crawler reports a planted leak. Runs: **locally in CI** (inside the E2E job, so it gates every deploy; the rows are removed afterwards) and **on staging after each deploy** (D-24), where the sentinel rows **stay**: the owner sees a few clearly named test items in the admin, and one "Leak test public item" in the "Leak test" category on the public staging site; between runs the two toggle items are both private (`toggle-rest.sql`, owner request 2026-11-25). Reports print labels, never values, so CI logs can't leak real keys. The visitor's own search words echoed on a page are not counted. | Proves INV-1 on every surface, on the real deployed stack, after every change. Keeping the staging rows makes each run cheap and comparable; they never exist in production (M7 runs the suite against staging only, D-39). |
| D-57 | **Prices are in US dollars (owner decision 2026-11-24; amends §4 "integer cents plus an ISO 4217 currency").** The admin no longer asks for a currency: the price field reads "Purchase price (USD)", and a price saved without a currency is stored as `USD`. The `purchase_currency` column stays (a constant costs nothing and keeps the option open); removing it would need a rebuild of `items`, which many tables reference with cascading deletes. Valuations (M6) follow the same rule. | The owner buys in US dollars; one less field to fill in. |
| D-58 | **Backup implementation details (amends D-47 and O-06; recorded 2026-11-24 after checking current vendor docs).** (1) **Alerts use Cloudflare Email Sending, not Email Routing.** Sending is a separate product (currently **beta**): onboarding the domain adds records only on the `cf-bounce` subdomain plus a DKIM key, so the apex SPF `-all` and DMARC `p=reject` stay as they are. On Workers Paid a Worker may send to any address, so the owner's mailbox needn't be verified; alerts count against the 3,000 included emails a month. Email Routing (inbound) stays **off**. The weekly GitHub `backup:verify` remains the independent second alarm, important while Email Sending is beta. (2) **One hourly cron** (`15 * * * *`): each run exports the database only if today's daily (or this month's monthly) copy is missing, then syncs media (at most 200 uploads per run). A failed night is retried an hour later. (3) **Keys are created through Backblaze's API** by `scripts/b2-setup-keys.ps1`, because the web console only makes preset keys that can delete; the owner runs it with a temporary master key and cancels that key afterwards by generating a new one and not saving it. Both job and verify keys are restricted to the two buckets (`bucketIds`). (4) Each upload sets its own Object Lock retention (governance; daily 30 days, monthly 365, media 365) and SSE-B2; bucket default retention stays off; lifecycle rules remove expired copies. (5) The weekly verify workflow is gated on the repository variable `BACKUPS_ENABLED`, set once setup is complete. (6) `npm run db:export` / `db:restore` export a database to the backup format and restore one into an empty, migrated local database, comparing row counts. Restoring onto a deployed database stays a reviewed manual step until the restore drill (BAK-08). | Vendor facts changed since D-47 was written (Email Sending split from Email Routing; key capabilities only via API). The choices keep the owner's DNS lockdown, give the fastest first backup, and keep no credential able to delete backups except the offline break-glass key. |
| D-59 | **Milestone order and video length (owner decisions 2026-11-25; amends §12, D-14, MED-08, IMP-01, TST-05).** (1) **M4 (video) is built before M2 (import/export)**, so the Instagram import handles every post, videos included, in one pass and the owner reviews each post once. (2) **Maximum video length is 120 s** (was 60 s): the owner found 60 s forced rushing. MED-08's "≤ 60 s", the M4 exit test ("60 s iPhone clip"), IMP-01's "60 s video limit" and TST-05's ">60 s video" all read 120 s. (3) The uploader offers a simple start/end **trim** (MED-08's optional trimming, now in scope). | One review pass per imported post. A 2-minute 1080p public file at the planned bitrate is about 75 MB, and processing on the phone stays in the order of a minute or two. |
| D-60 | **Video storage, upload and playback (implements MED-08/09/10/12, PUB-06; recorded 2026-11-25).** (1) **Like photos (D-43):** the original never leaves the device. The browser makes a private **master** (metadata stripped, H.264/AAC MP4, up to 1080p at a higher bitrate) and the public **derivative** (H.264 + AAC-LC MP4, ≤1080p, ~4–5 Mbps, `faststart`), plus a poster image through the photo pipeline. The master lets M5 burn in the watermark (MED-06) without a second generation of quality loss; it is backed up like photo masters (BAK-03). (2) **Chunked upload** through the admin Worker (R2 multipart), so no file meets the 100 MB request-body limit of the zone's Cloudflare plan and a dropped phone connection resumes. MED-03's "video 100 MB original" applies to each stored file, not to the input on the device. (3) **Verify on arrival (as D-51):** the Worker parses every stored MP4 before writing it: allow-listed boxes only (no `udta`/`meta`/location boxes), `avc1` + `mp4a` tracks only, `moov` before `mdat`, duration ≤ 120 s, ≤1080p, exact size. (4) **Playback in every current browser:** H.264 + AAC-LC in MP4 is the baseline every current browser plays (Chrome, Edge, Firefox, Safari, DuckDuckGo and other WebKit/Chromium browsers). Served with HTTP Range support from R2, the same visibility rule as photos (MED-10). (5) The watermark is M5; M4 videos are re-made from masters then. | Same privacy model and verification as photos; one format that plays everywhere; resumable uploads from a phone. |
| D-61 | **Video library: Mediabunny (checked 2026-11-25).** Reading MOV/MP4 (H.264 or HEVC), converting to H.264 + AAC MP4 with WebCodecs, trimming, frame extraction for posters and metadata removal use `mediabunny` (MPL-2.0, zero dependencies, tree-shakable, ~8 million weekly downloads, releases weekly), loaded only in the admin. Where a browser lacks a WebCodecs AAC encoder, its WASM AAC encoder package is used (the admin CSP already allows `wasm-unsafe-eval`, D-44). Location-metadata removal is verified by our own server check (D-60) and a test with a real iPhone clip, not assumed from the library docs. WebCodecs is fully supported from Safari/iOS 26 and in Chrome; a device-capability test on the owner's iPhone and desktop is the first build step. | Widely used and actively maintained; avoids writing an MP4 muxer; the security-relevant check (no metadata) stays on our server. |
| D-62 | **Instagram import plan (owner decisions 2026-11-25; amends IMP-01/IMP-04, extends D-42; built in M2).** (1) Before importing, an **import plan file** is prepared per post (proposed title with confidence and source, skip / maybe-skip, duplicate group, caption edits); it is the owner's content and stays out of the public repository, next to the export. (2) **Titles name the object:** meteorites "Name - Type" with the type in words (e.g. "Tagish Lake - C2 Ungrouped", "Gibeon - Iron, IVA"); minerals by main mineral plus companions named in the caption; other objects by what they are; a date or date range from the caption goes in brackets at the end ("… Tetradrachm (336–323 BC)"). (3) **Hashtag rules:** the owner maps a hashtag to a category or tag once and it applies to every draft with that hashtag (an explicit owner choice, so D-42's "no automatic tags" stands). (4) Captions keep **people's names** as written; only @handles and the trailing hashtag block are removed; a digit-only "hashtag" (#1, #2) is numbering and stays. (5) The Instagram date is the public **"Posted"** date; purchase date and price stay empty. (6) Posts that aren't objects and repeat posts of the same object are flagged; the owner keeps one. (7) Review screen: one draft at a time (Publish & next / Save & next / Skip) plus checkbox bulk actions in the draft list. | Titles and rules prepared once save hundreds of edits; nothing in a caption is lost (the original stays admin-only, D-42). |
| D-63 | **Screen wake lock on admin only (owner decision 2026-11-25; amends the admin Permissions-Policy).** The admin's `Permissions-Policy` allows `screen-wake-lock=(self)`, so the phone screen stays on while a video is processed on the device (D-60); if the screen locks, Safari pauses the page and processing stops. The public site keeps denying it, as before. Found by the M4 device check page. | Processing a 2-minute clip takes a minute or two on a phone; a locked screen would lose the work. The feature only keeps the screen on; it grants no access to data. |

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
9. Browser support: WebCodecs `VideoEncoder`/`AudioEncoder` (especially iOS Safari), HEIC decode in Safari, WebP encode via canvas or WASM. (Checked 2026-11-25: WebCodecs fully supported from Safari/iOS 26 and in Chrome; per-device codec support is tested on the owner's devices, D-61.)
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
| O-05 | Create a Backblaze B2 account (TOTP 2FA, D-47); create the staging buckets and keys; store the break-glass key offline | M1 |
| O-06 | Enable Cloudflare AI-crawler blocking (M5); onboard the domain to Cloudflare **Email Sending** for backup alerts (M1, D-47 amended by D-58; Email Routing stays off) | M1/M5 |
| O-07 | Set up Google Search Console + Safe Browsing alerts | M7 |
| O-08 | Request the Instagram data export (JSON) early, since it can take time to prepare | Before M2 |
| O-09 | Provide owner display name (a pen name; currently Insignificant Nobody, D-49), About text, watermark text and an avatar/hero image | M5 |
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
