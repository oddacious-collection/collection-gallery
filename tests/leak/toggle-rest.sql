-- Privacy-leak suite (TST-02): resting state between staging runs, both toggle
-- items private, so the only test item on the public staging site is
-- "Leak test public item" (owner request 2026-11-25). Each run starts from
-- toggle-a.sql. Mirrors the admin data layer: status change plus un-indexing.
UPDATE items SET status = 'private', updated_at = '1901-02-03T04:05:06.000Z'
WHERE id IN ('01SENTA0000000000000000001', '01SENTB0000000000000000001');
DELETE FROM search_index WHERE item_id IN ('01SENTA0000000000000000001', '01SENTB0000000000000000001');
