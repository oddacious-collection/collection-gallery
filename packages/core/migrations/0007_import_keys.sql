-- M2 step 3 (D-62, D-70): the Instagram import's bookkeeping, all admin-only.
-- items.import_key makes re-runs skip items already imported (IMP-03);
-- media.source_hash lets a resumed import skip files already added;
-- hashtag_rules holds the owner's hashtag -> category/tag choices.
-- Only new columns and a new table: nothing existing is rebuilt.
CREATE TABLE `hashtag_rules` (
	`hashtag` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`tag_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "hashtag_rules_target_check" CHECK("hashtag_rules"."category_id" IS NOT NULL OR "hashtag_rules"."tag_name" IS NOT NULL),
	CONSTRAINT "hashtag_rules_hashtag_check" CHECK("hashtag_rules"."hashtag" = lower("hashtag_rules"."hashtag") AND length("hashtag_rules"."hashtag") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX `hashtag_rules_category_idx` ON `hashtag_rules` (`category_id`);--> statement-breakpoint
ALTER TABLE `items` ADD `import_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `items_import_key_unique` ON `items` (`import_key`);--> statement-breakpoint
ALTER TABLE `media` ADD `source_hash` text;--> statement-breakpoint
CREATE INDEX `media_source_hash_idx` ON `media` (`item_id`,`source_hash`);