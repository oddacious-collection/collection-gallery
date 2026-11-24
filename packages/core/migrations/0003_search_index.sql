-- Public search index (PUB-08). Hand-written: Drizzle can't generate FTS5
-- virtual tables. See packages/core/src/db/search.ts.
--
-- INV-1: holds only public text (title, description, tag names, category
-- names) of only publicly visible items. Kept in step by the admin data layer
-- (admin/search-index.ts) in the same batch as each change.
CREATE VIRTUAL TABLE `search_index` USING fts5(
	item_id UNINDEXED,
	title,
	body,
	tags,
	categories,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
-- Backfill: index items that are already public.
INSERT INTO `search_index` (item_id, title, body, tags, categories)
SELECT
	i.id,
	i.title,
	i.description,
	coalesce((
		SELECT group_concat(t.name, ' ')
		FROM item_tags it JOIN tags t ON t.id = it.tag_id
		WHERE it.item_id = i.id
	), ''),
	coalesce((
		SELECT group_concat(c.name, ' ')
		FROM categories c
		WHERE c.id IN (
			SELECT cc.ancestor_id
			FROM item_categories ic
			JOIN category_closure cc ON cc.descendant_id = ic.category_id
			WHERE ic.item_id = i.id
		)
	), '')
FROM items i
WHERE i.status = 'public' AND i.kind = 'owned' AND i.deleted_at IS NULL;
