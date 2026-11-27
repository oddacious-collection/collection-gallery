-- Captions (MED-12, D-65): allow the 'captions' role in media_variants.
-- SQLite can't change a CHECK constraint, so the table is rebuilt. Safe: no
-- table references media_variants, so dropping it cascades nowhere; every row
-- is copied first. No foreign_keys PRAGMA: D1 runs migrations in a
-- transaction, where that PRAGMA has no effect (as in 0004).
CREATE TABLE `__new_media_variants` (
	`key` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`role` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`format` text NOT NULL,
	`bytes` integer NOT NULL,
	`watermarked` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_variants_role_check" CHECK("role" IN ('image', 'og', 'poster', 'video', 'captions'))
);
--> statement-breakpoint
INSERT INTO `__new_media_variants`("key", "media_id", "role", "width", "height", "format", "bytes", "watermarked") SELECT "key", "media_id", "role", "width", "height", "format", "bytes", "watermarked" FROM `media_variants`;--> statement-breakpoint
DROP TABLE `media_variants`;--> statement-breakpoint
ALTER TABLE `__new_media_variants` RENAME TO `media_variants`;--> statement-breakpoint
CREATE INDEX `media_variants_media_idx` ON `media_variants` (`media_id`);
