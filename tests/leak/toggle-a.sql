-- Privacy-leak suite (TST-02): toggle state, ALPHA public, BETA private (phase A).
-- Mirrors what the admin data layer does: status change plus re-indexing.
UPDATE items SET status = 'public', updated_at = '1901-02-03T04:05:06.000Z' WHERE id = '01SENTA0000000000000000001';
UPDATE items SET status = 'private', updated_at = '1901-02-03T04:05:06.000Z' WHERE id = '01SENTB0000000000000000001';
DELETE FROM search_index WHERE item_id IN ('01SENTA0000000000000000001', '01SENTB0000000000000000001');
INSERT INTO search_index (item_id, title, body, tags, categories)
SELECT i.id, i.title, i.description,
  coalesce((SELECT group_concat(t.name, ' ') FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id), ''),
  coalesce((SELECT group_concat(c.name, ' ') FROM categories c WHERE c.id IN (
    SELECT cc.ancestor_id FROM item_categories ic JOIN category_closure cc ON cc.descendant_id = ic.category_id
    WHERE ic.item_id = i.id)), '')
FROM items i
WHERE i.id IN ('01SENTA0000000000000000001', '01SENTB0000000000000000001')
  AND i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL;
