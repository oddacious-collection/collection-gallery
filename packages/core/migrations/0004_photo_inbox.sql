CREATE TABLE `inbox_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`parts` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`content_hash` text,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "inbox_photos_dimensions_check" CHECK("inbox_photos"."width" > 0 AND "inbox_photos"."height" > 0)
);
--> statement-breakpoint
CREATE INDEX `inbox_photos_created_idx` ON `inbox_photos` (`created_at`);--> statement-breakpoint
-- Rebuild media_uploads to make item_id nullable (SQLite can't alter a column).
-- Safe: no table references media_uploads, so dropping it cascades nowhere;
-- its rows are short-lived uploads in progress. No foreign_keys PRAGMA: D1
-- runs migrations in a transaction, where that PRAGMA has no effect.
--> statement-breakpoint
CREATE TABLE `__new_media_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text,
	`parts` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_media_uploads`("id", "item_id", "parts", "created_at") SELECT "id", "item_id", "parts", "created_at" FROM `media_uploads`;--> statement-breakpoint
DROP TABLE `media_uploads`;--> statement-breakpoint
ALTER TABLE `__new_media_uploads` RENAME TO `media_uploads`;--> statement-breakpoint
CREATE INDEX `media_uploads_created_idx` ON `media_uploads` (`created_at`);