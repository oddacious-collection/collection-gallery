-- Privacy-leak suite (TST-02): sentinel data.
--
-- Idempotent (fixed IDs, INSERT OR IGNORE), so it is safe to apply on every
-- run, locally (CI deploy gate) and on staging (post-deploy crawl, D-24).
-- Every ADMIN value below is a unique, greppable marker that must never
-- appear on any public surface. IDs are valid ULIDs starting 01SENT; private
-- storage keys start 0sentkey (no files exist for them: they must 404).
--
-- Visible on staging: one public item "Leak test public item" in the public
-- category "Leak test", and a few clearly named hidden items in the admin.

-- ------------------------------------------------------------------ categories
INSERT OR IGNORE INTO categories (id, parent_id, name, slug, description, position, created_at, updated_at) VALUES
  ('01SENTC0000000000000000001', NULL, 'Leak test', 'leak-test',
   'Automated privacy test (TST-02). Safe to ignore.', 999, '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z'),
  ('01SENTC0000000000000000002', NULL, 'SENTINEL-SQL-HIDDEN-CATEGORY', 'sentinel-sql-hidden-category',
   'SENTINEL-SQL-HIDDEN-CATEGORY-DESCRIPTION', 1000, '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO category_closure (ancestor_id, descendant_id, depth) VALUES
  ('01SENTC0000000000000000001', '01SENTC0000000000000000001', 0),
  ('01SENTC0000000000000000002', '01SENTC0000000000000000002', 0);

-- ------------------------------------------------------------------ items
-- P: public, with every admin field set to a marker.
INSERT OR IGNORE INTO items (id, slug, kind, status, title, description, posted_at, license_override,
  watermark_override, purchase_price_cents, purchase_currency, purchase_date, open_to_parting,
  source_caption, suggested_tags, created_at, updated_at, deleted_at) VALUES
  ('01SENTP0000000000000000001', 'leak-test-public-item', 'owned', 'public', 'Leak test public item',
   'Automated privacy test (TST-02). Its private fields hold marker values that must never appear here.',
   '2001-01-01T00:00:00.000Z', NULL, 'off', 987654321, 'ZQX', '1901-02-03', 1,
   'SENTINEL-SQL-SOURCE-CAPTION', '["SENTINEL-SQL-SUGGESTED-TAG"]',
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL),
  -- Never public, one of each kind.
  ('01SENTD0000000000000000001', 'sentinel-sql-draft', 'owned', 'draft', 'SENTINEL-SQL-DRAFT-TITLE',
   'SENTINEL-SQL-DRAFT-DESCRIPTION', NULL, NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL),
  ('01SENTV0000000000000000001', 'sentinel-sql-private', 'owned', 'private', 'SENTINEL-SQL-PRIVATE-TITLE',
   'SENTINEL-SQL-PRIVATE-DESCRIPTION', '2001-01-02T00:00:00.000Z', NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL),
  ('01SENTW0000000000000000001', 'sentinel-sql-wishlist', 'wishlist', 'draft', 'SENTINEL-SQL-WISHLIST-TITLE',
   'SENTINEL-SQL-WISHLIST-DESCRIPTION', NULL, NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL),
  ('01SENTX0000000000000000001', 'sentinel-sql-trashed', 'owned', 'public', 'SENTINEL-SQL-TRASHED-TITLE',
   'SENTINEL-SQL-TRASHED-DESCRIPTION', '2001-01-03T00:00:00.000Z', NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', '1901-02-04T00:00:00.000Z'),
  -- Toggled between runs (toggle-a.sql / toggle-b.sql).
  ('01SENTA0000000000000000001', 'leak-test-toggle-alpha', 'owned', 'public', 'LEAKTOGGLE-SQL-ALPHA',
   'Automated privacy test (TST-02).', '2001-01-04T00:00:00.000Z', NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL),
  ('01SENTB0000000000000000001', 'leak-test-toggle-beta', 'owned', 'private', 'LEAKTOGGLE-SQL-BETA',
   'Automated privacy test (TST-02).', '2001-01-05T00:00:00.000Z', NULL, 'inherit', NULL, NULL, NULL, 0, NULL, NULL,
   '1901-02-03T04:05:06.000Z', '1901-02-03T04:05:06.000Z', NULL);

INSERT OR IGNORE INTO item_categories (item_id, category_id) VALUES
  ('01SENTP0000000000000000001', '01SENTC0000000000000000001'),
  ('01SENTA0000000000000000001', '01SENTC0000000000000000001'),
  ('01SENTB0000000000000000001', '01SENTC0000000000000000001'),
  ('01SENTD0000000000000000001', '01SENTC0000000000000000002'),
  ('01SENTV0000000000000000001', '01SENTC0000000000000000001'),
  ('01SENTV0000000000000000001', '01SENTC0000000000000000002'),
  ('01SENTW0000000000000000001', '01SENTC0000000000000000002'),
  ('01SENTX0000000000000000001', '01SENTC0000000000000000001');

INSERT OR IGNORE INTO tags (id, name, slug, created_at) VALUES
  ('01SENTG0000000000000000001', 'Leak test', 'leak-test', '1901-02-03T04:05:06.000Z'),
  ('01SENTG0000000000000000002', 'SENTINEL-SQL-HIDDEN-TAG', 'sentinel-sql-hidden-tag', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES
  ('01SENTP0000000000000000001', '01SENTG0000000000000000001'),
  ('01SENTV0000000000000000001', '01SENTG0000000000000000002');

-- An old slug of a private item must 404 (never redirect); one of a public item redirects.
INSERT OR IGNORE INTO slug_redirects (old_slug, item_id, created_at) VALUES
  ('sentinel-sql-private-old-slug', '01SENTV0000000000000000001', '1901-02-03T04:05:06.000Z'),
  ('leak-test-public-item-old', '01SENTP0000000000000000001', '1901-02-03T04:05:06.000Z');

-- ------------------------------------------------------------------ media (private item; no files exist)
INSERT OR IGNORE INTO media (id, item_id, position, is_cover, kind, original_key, width, height,
  alt_text, content_hash, created_at) VALUES
  ('01SENTM0000000000000000001', '01SENTV0000000000000000001', 0, 1, 'image', '0sentkey0000000000000000a1',
   400, 300, 'SENTINEL-SQL-PRIVATE-ALT', 'SENTINEL-SQL-CONTENT-HASH', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO media_variants (key, media_id, role, width, height, format, bytes) VALUES
  ('0sentkey0000000000000000a2', '01SENTM0000000000000000001', 'image', 400, 300, 'image/webp', 1),
  ('0sentkey0000000000000000a3', '01SENTM0000000000000000001', 'og', 400, 300, 'image/jpeg', 1);

-- ------------------------------------------------------------------ admin-only records of the PUBLIC item
INSERT OR IGNORE INTO field_definitions (id, category_id, key, label, type, options, visibility, position) VALUES
  ('01SENTF0000000000000000001', '01SENTC0000000000000000001', 'sentinel_admin_field',
   'SENTINEL-SQL-ADMIN-FIELD-LABEL', 'text', NULL, 'admin', 0);
INSERT OR IGNORE INTO item_field_values (item_id, field_id, value) VALUES
  ('01SENTP0000000000000000001', '01SENTF0000000000000000001', 'SENTINEL-SQL-ADMIN-FIELD-VALUE');
INSERT OR IGNORE INTO valuations (id, item_id, date, value_cents, currency, source, note, created_at) VALUES
  ('01SENTQ0000000000000000001', '01SENTP0000000000000000001', '1901-02-03', 987654322, 'ZQX',
   'SENTINEL-SQL-VALUATION-SOURCE', 'SENTINEL-SQL-VALUATION-NOTE', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO provenance_events (id, item_id, date, type, counterparty, description, created_at) VALUES
  ('01SENTR0000000000000000001', '01SENTP0000000000000000001', '1901-02-03', 'acquired',
   'SENTINEL-SQL-COUNTERPARTY', 'SENTINEL-SQL-PROVENANCE', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO documents (id, item_id, provenance_event_id, key, filename, mime, size, created_at) VALUES
  ('01SENTS0000000000000000001', '01SENTP0000000000000000001', '01SENTR0000000000000000001',
   '0sentkey0000000000000000d1', 'SENTINEL-SQL-DOCUMENT.pdf', 'application/pdf', 1, '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO permission_grants (id, requester_name, requester_email, item_id, intended_use,
  credit_line, granted_on, terms, notes, created_at) VALUES
  ('01SENTH0000000000000000001', 'SENTINEL-SQL-GRANTEE', 'sentinel-sql-grantee@example.invalid',
   '01SENTP0000000000000000001', 'SENTINEL-SQL-INTENDED-USE', 'SENTINEL-SQL-CREDIT', '1901-02-03',
   'SENTINEL-SQL-TERMS', 'SENTINEL-SQL-GRANT-NOTES', '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO permission_requests (id, received_at, name, email, item_id, intended_use, where_used,
  credit_line, message) VALUES
  ('01SENTJ0000000000000000001', '1901-02-03T04:05:06.000Z', 'SENTINEL-SQL-REQUESTER',
   'sentinel-sql-requester@example.invalid', '01SENTP0000000000000000001', 'SENTINEL-SQL-REQUEST-USE',
   'SENTINEL-SQL-WHERE-USED', 'SENTINEL-SQL-REQUEST-CREDIT', 'SENTINEL-SQL-REQUEST-MESSAGE');
INSERT OR IGNORE INTO item_revisions (id, item_id, snapshot, created_at) VALUES
  ('01SENTK0000000000000000001', '01SENTP0000000000000000001', '{"v":1,"note":"SENTINEL-SQL-REVISION"}',
   '1901-02-03T04:05:06.000Z');
INSERT OR IGNORE INTO audit_log (id, at, actor_email, action, target_type, target_id, details) VALUES
  ('01SENTY0000000000000000001', '1901-02-03T04:05:06.000Z', 'sentinel-sql-actor@example.invalid',
   'sentinel.test', 'item', '01SENTP0000000000000000001', '{"note":"SENTINEL-SQL-AUDIT"}');
INSERT OR IGNORE INTO analytics_daily (date, item_id, metric, country, region, referrer_host, count) VALUES
  ('1901-02-03', '01SENTP0000000000000000001', 'view', 'ZQ', 'SENTINEL-SQL-REGION', 'sentinel-sql-referrer.invalid', 7);
INSERT OR IGNORE INTO like_dedupe (date, item_id, hash) VALUES
  ('1901-02-03', '01SENTP0000000000000000001', 'SENTINEL-SQL-LIKE-HASH');
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('sentinel_admin_setting', 'SENTINEL-SQL-SETTING', '1901-02-03T04:05:06.000Z');

-- ------------------------------------------------------------------ an inbox photo (D-55; no files exist)
INSERT OR IGNORE INTO inbox_photos (id, parts, width, height, content_hash, created_at) VALUES
  ('01SENTZ0000000000000000001',
   '[{"name":"original","role":"original","format":"image/jpeg","width":400,"height":300,"maxBytes":31457280,"key":"0sentkey0000000000000000e1","bytes":1},{"name":"w400","role":"image","format":"image/webp","width":400,"height":300,"maxBytes":8388608,"key":"0sentkey0000000000000000e2","bytes":1}]',
   400, 300, 'SENTINEL-SQL-INBOX-HASH', '1901-02-03T04:05:06.000Z');

-- ------------------------------------------------------------------ search index for the public sentinel item
DELETE FROM search_index WHERE item_id = '01SENTP0000000000000000001';
INSERT INTO search_index (item_id, title, body, tags, categories)
SELECT i.id, i.title, i.description,
  coalesce((SELECT group_concat(t.name, ' ') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), ''),
  coalesce((SELECT group_concat(c.name, ' ') FROM categories c WHERE c.id IN (
    SELECT cc.ancestor_id FROM item_categories ic JOIN category_closure cc ON cc.descendant_id = ic.category_id
    WHERE ic.item_id = i.id)), '')
FROM items i
WHERE i.id = '01SENTP0000000000000000001' AND i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL;
