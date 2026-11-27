-- Removes the leak-suite sentinel rows from LOCAL state (never used on staging,
-- where they stay so each run finds them). Children go by ON DELETE CASCADE.
DELETE FROM search_index WHERE item_id LIKE '01SENT%';
DELETE FROM permission_requests WHERE id LIKE '01SENT%';
DELETE FROM permission_grants WHERE id LIKE '01SENT%';
DELETE FROM analytics_daily WHERE item_id LIKE '01SENT%';
DELETE FROM like_dedupe WHERE item_id LIKE '01SENT%';
DELETE FROM audit_log WHERE id LIKE '01SENT%';
DELETE FROM settings WHERE key = 'sentinel_admin_setting';
DELETE FROM hashtag_rules WHERE hashtag = 'sentinelsqlhashtag';
DELETE FROM inbox_photos WHERE id LIKE '01SENT%';
DELETE FROM items WHERE id LIKE '01SENT%';
DELETE FROM tags WHERE id LIKE '01SENT%';
DELETE FROM field_definitions WHERE id LIKE '01SENT%';
DELETE FROM category_closure WHERE ancestor_id LIKE '01SENT%';
DELETE FROM categories WHERE id LIKE '01SENT%';
